import type { Frame, Page } from "playwright-core";
import { inSequence } from "../shared/async.ts";
import { messageOf } from "../shared/errors.ts";
import { type ConsentChoice, type OverlayCandidate, type OverlayKind, scanFrame } from "./scan.ts";

export type OverlayClick = OverlayCandidate & {
  frame: string;
  clicked: boolean;
  skipped?: boolean;
  error?: string;
  closedBy?: string;
  tried?: string[];
};

function frameLabel(page: Page, frame: Frame) {
  return frame === page.mainFrame()
    ? "main frame"
    : `frame ${frame.url().slice(0, 80) || frame.name()}`;
}

const MODAL_GONE_MS = 1500;

function modalGone(frame: Frame, overlay: string) {
  return frame
    .locator(`[data-web-agent-overlay="${overlay}"]`)
    .waitFor({ state: "hidden", timeout: MODAL_GONE_MS })
    .then(() => true)
    .catch(() => false);
}

function backdropPoint(overlay: string) {
  const container = document.querySelector(`[data-web-agent-overlay="${overlay}"]`);
  if (!container) return undefined;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const covers = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.width * box.height >= 0.9 * width * height;
  };
  const dom = {
    fixed(element: Element) {
      for (
        let node: Element | null = element;
        node && node !== document.body;
        node = node.parentElement
      ) {
        if (getComputedStyle(node).position === "fixed") return true;
      }
      return false;
    },
    area(element: Element) {
      return element.getBoundingClientRect().width * element.getBoundingClientRect().height;
    },
  };
  const dialog = covers(container)
    ? [...container.querySelectorAll("*")]
        .filter((element) => !covers(element))
        .toSorted((left, right) => dom.area(right) - dom.area(left))[0]
    : container;
  const box = dialog?.getBoundingClientRect();
  if (!box) return undefined;
  const points = [
    [8, 8],
    [width - 8, 8],
    [8, height - 8],
    [width - 8, height - 8],
  ];
  for (const [x = 0, y = 0] of points) {
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === document.body || hit === document.documentElement || dialog?.contains(hit))
      continue;
    if (hit.closest("a, button, input, select, textarea, label, [role=button], [role=link]"))
      continue;
    let backdrop: Element | null = hit;
    while (backdrop && backdrop !== document.body && !(covers(backdrop) && dom.fixed(backdrop)))
      backdrop = backdrop.parentElement;
    if (backdrop && backdrop !== document.body) return { x, y };
  }
  return undefined;
}

async function closeModal(page: Page, frame: Frame, click: OverlayClick) {
  const tried: string[] = [];
  if (click.marker) {
    tried.push(`clicking "${click.label}"`);
    if (click.clicked && (await modalGone(frame, click.overlay))) {
      click.closedBy = `clicking "${click.label}" (${click.kind})`;
      return;
    }
  }
  tried.push("Escape");
  await page.keyboard.press("Escape").catch(() => undefined);
  if (await modalGone(frame, click.overlay)) {
    click.closedBy = "pressing Escape";
    return;
  }
  const point =
    frame === page.mainFrame()
      ? await frame.evaluate(backdropPoint, click.overlay).catch(() => undefined)
      : undefined;
  if (point) {
    tried.push("a click outside it");
    await page.mouse.click(point.x, point.y).catch(() => undefined);
    if (await modalGone(frame, click.overlay)) {
      click.closedBy = "a click outside it";
      return;
    }
  }
  click.tried = tried;
}

type DismissOptions = {
  consent?: ConsentChoice;
  allowAccept?: boolean;
  consentOnly?: boolean;
};

export async function dismissOverlays(page: Page, options: DismissOptions = {}) {
  const choice = options.consent ?? "accept";
  const allowAccept = options.allowAccept ?? true;
  const seed = Date.now().toString(36);
  const perFrame = await inSequence(page.frames(), async (frame, index) => {
    if (frame.isDetached()) return [];
    const wholeFrame =
      frame !== page.mainFrame() &&
      /consent|cmp|cookie|privacy|sp_message|sourcepoint|trustarc|didomi|onetrust/i.test(
        `${frame.url()} ${frame.name()}`,
      );
    const found = await scanFrame(frame, {
      wholeFrame,
      seed: `${seed}-${index}`,
      choice,
      consentOnly: options.consentOnly ?? false,
    });
    return inSequence(found, async (candidate): Promise<OverlayClick> => {
      const kind: OverlayKind = candidate.kind === "accept_all" ? "accept" : candidate.kind;
      const click: OverlayClick = {
        ...candidate,
        kind,
        frame: frameLabel(page, frame),
        clicked: false,
      };
      if (kind === "accept" && choice === "reject" && !allowAccept)
        return { ...click, skipped: true };
      if (candidate.marker) {
        try {
          await frame
            .locator(`[data-web-agent-dismiss="${candidate.marker}"]`)
            .click({ timeout: 3000 });
          click.clicked = true;
        } catch (cause) {
          click.error = messageOf(cause).split("\n")[0];
        }
      }
      if (candidate.modal) await closeModal(page, frame, click);
      return click;
    });
  });
  return perFrame.flat();
}

function describeModal(click: OverlayClick) {
  const where = `Modal ${click.container} in ${click.frame}`;
  if (click.closedBy) return `${where}: closed by ${click.closedBy}.`;
  const failed = click.error ? ` The click on "${click.label}" failed: ${click.error}` : "";
  return `${where}: found, but no close control worked (tried ${(click.tried ?? []).join(", ")}).${failed}`;
}

export function describeOverlayClicks(clicks: OverlayClick[]) {
  if (clicks.length === 0) return "No cookie banner or modal was found.";
  return clicks
    .map((click) =>
      click.modal
        ? describeModal(click)
        : click.skipped
          ? `Left "${click.label}" (accept) in ${click.container}, ${click.frame} unclicked: the consent banner offers no reject or close control. Pass allow_accept: true to accept it.`
          : click.clicked
            ? `Clicked "${click.label}" (${click.kind}) in ${click.container}, ${click.frame}.`
            : `Found "${click.label}" (${click.kind}) in ${click.container}, ${click.frame}, but the click failed: ${click.error}`,
    )
    .join("\n");
}
