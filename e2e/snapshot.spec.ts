import { describe, expect, test } from "bun:test";
import { inSequence } from "../src/shared/async.ts";
import { useToolsHarness } from "./tools-harness.ts";

const { call, ok, fixture, mcp, openedTab, refOf } = useToolsHarness("snapshot");

async function openRoute(route: string) {
  return openedTab(await ok("navigate", { url: `${fixture().url}${route}` }));
}

describe("scoped snapshots", () => {
  test("a page with one main landmark is snapshotted from main", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    const text = await ok("snapshot", { tab });
    expect(text).not.toMatch(/Section 7/);
    await ok("tabs", { close: [tab] });
  });

  test("the scoped snapshot says what it left out and how to get it", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    const text = await ok("snapshot", { tab });
    expect(text).toMatch(
      /\[Scoped to the main landmark; 3 landmarks, 32 controls and 1 text line outside it are not shown\. Pass scope: "full" for the whole page\.\]/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("scope full returns the landmarks around main", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    expect(await ok("snapshot", { tab, scope: "full" })).toMatch(/link "Section 7"/);
    await ok("tabs", { close: [tab] });
  });

  test("a ref from a full snapshot works after a scoped one", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    const full = await ok("snapshot", { tab, scope: "full" });
    const scoped = await ok("snapshot", { tab });
    expect(refOf(scoped, 'button "Add to cart"')).toBe(refOf(full, 'button "Add to cart"'));
    await ok("tabs", { close: [tab] });
  });

  test("a link-only navigation menu is folded into one line", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    expect(await ok("snapshot", { tab })).toMatch(
      /navigation "Breadcrumb" \[ref=\w+\] \[2 links, collapsed\]/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a folded menu's ref as target lists its links", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    const menu = refOf(await ok("snapshot", { tab }), 'navigation "Breadcrumb"');
    expect(await ok("snapshot", { tab, target: menu })).toMatch(/link "Lamps"/);
    await ok("tabs", { close: [tab] });
  });

  test("an open modal dialog is snapshotted on its own", async () => {
    const tab = await openRoute("/snapshot/dialog");
    const text = await ok("snapshot", { tab });
    expect(text).toMatch(
      /\[Scoped to the open dialog; [^\]]*\]\n- dialog[^\n]*\n[\s\S]*button "Stay"/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("the dialog-scoped snapshot leaves the page behind it out", async () => {
    const tab = await openRoute("/snapshot/dialog");
    expect(await ok("snapshot", { tab })).not.toMatch(/Delete account/);
    await ok("tabs", { close: [tab] });
  });

  test("a clipped snapshot keeps controls and drops links first", async () => {
    const tab = await openRoute("/snapshot/landmarks");
    const text = await ok("snapshot", { tab, max_chars: 1500 });
    expect(text).toMatch(/button "Checkout"[\s\S]*\[snapshot clipped: kept \d+ of \d+ lines/);
    await ok("tabs", { close: [tab] });
  });
});

describe("refs across re-renders", () => {
  test("a ref whose button was drawn again is not used for the new button", async () => {
    const tab = await openRoute("/snapshot/rerender");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Re-render"') });
    await call("click", { tab, target: refOf(snapshot, 'button "Save"') });
    expect(await stateOf(tab)).toMatch(/idle/);
  });

  test("a ref whose element is gone says so", async () => {
    const tab = await openRoute("/snapshot/rerender");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Remove save"') });
    const result = await call("click", { tab, target: refOf(snapshot, 'button "Save"') });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: its button "Save" is gone from the page\.[\s\S]*Take a new snapshot/,
    );
  });
});

describe("snapshot queries", () => {
  test("a query lists the buttons named exactly like it first, each with its row", async () => {
    const tab = await openRoute("/snapshot/cart");
    const found = await ok("snapshot", { tab, query: "Sil" });
    await ok("tabs", { close: [tab] });
    expect(found.split("\n").slice(1, 4)).toStrictEqual([
      expect.stringMatching(/^\d+ matches:$/),
      expect.stringMatching(/^button "Sil" \[ref=\w+\] — in row "Silikon Kılıf 249 TL"$/),
      expect.stringMatching(/^button "Sil" \[ref=\w+\] — in row "Ekran Koruyucu 99 TL"$/),
    ]);
  });

  test("a query lists the elements that only contain it under their own heading", async () => {
    const tab = await openRoute("/snapshot/cart");
    const found = await ok("snapshot", { tab, query: "Sil" });
    await ok("tabs", { close: [tab] });
    expect(found).toMatch(
      /\nAlso contains "Sil":\ncell "Silikon Kılıf" \[ref=\w+\] — in row "Silikon Kılıf 249 TL"\n/,
    );
  });
});

describe("several refs from one snapshot", () => {
  test("a second twin button clicks after the first one with nothing changed", async () => {
    const tab = await openRoute("/snapshot/cart-twins");
    const snapshot = await ok("snapshot", { tab });
    const [first = "", second = ""] = [...snapshot.matchAll(/button "Sil" \[ref=(\w+)\]/g)].map(
      (match) => match[1] ?? "",
    );
    await ok("click", { tab, target: first });
    await ok("click", { tab, target: second });
    expect(await stateOf(tab)).toMatch(/second/);
  });

  test("a ref in a list item whose text a depth cut hid clicks its button", async () => {
    const tab = await openRoute("/snapshot/deep-rows");
    const snapshot = await ok("snapshot", { tab, scope: "full", depth: 3 });
    await ok("click", { tab, target: refOf(snapshot, 'button "Sil"') });
    expect(await stateOf(tab)).toMatch(/deleted Kılıf A/);
  });
});

describe("a ref used twice", () => {
  test("a button whose row text changed after a click clicks again with the same ref", async () => {
    const tab = await openRoute("/snapshot/quantity");
    const plus = refOf(await ok("snapshot", { tab }), 'button "Artır"');
    await ok("click", { tab, target: plus });
    await ok("click", { tab, target: plus });
    expect(await stateOf(tab)).toMatch(/3 adet/);
  });

  test("a button whose row text changed clicks again with a ref from a new snapshot", async () => {
    const tab = await openRoute("/snapshot/quantity");
    await ok("click", { tab, target: refOf(await ok("snapshot", { tab }), 'button "Artır"') });
    await ok("click", { tab, target: refOf(await ok("snapshot", { tab }), 'button "Artır"') });
    expect(await stateOf(tab)).toMatch(/3 adet/);
  });

  test("a ref an action showed for a selector clicks again after its row text changed", async () => {
    const tab = await openRoute("/snapshot/quantity");
    const clicked = await ok("click", { tab, target: "text=Artır" });
    const shown = /\((\w+), from text=Artır\)/.exec(clicked)?.[1] ?? "";
    await ok("click", { tab, target: shown });
    expect(await stateOf(tab)).toMatch(/3 adet/);
  });

  test("a ref an action showed for a selector is not used after the page moved to another address", async () => {
    const tab = await openRoute("/snapshot/order?id=A");
    const hovered = await ok("hover", { tab, target: "text=İptal et" });
    const shown = /\((\w+), from text=İptal et\)/.exec(hovered)?.[1] ?? "";
    await ok("click", { tab, target: "text=Sonraki sipariş" });
    await call("click", { tab, target: shown });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test("a button whose own name changed after a click is not clicked again", async () => {
    const tab = await openRoute("/snapshot/quantity");
    const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    await ok("click", { tab, target: follow });
    await call("click", { tab, target: follow });
    const follows = await ok("read_page", { tab, target: "#follows" });
    await ok("tabs", { close: [tab] });
    expect(follows).toMatch(/\b1 follows/);
  });
});

describe("refs from an earlier page", () => {
  test("a ref from before a reload is not used on the reloaded page", async () => {
    const tab = await openRoute("/snapshot/cart");
    const before = refOf(await ok("snapshot", { tab, query: "Sil" }), "Silikon Kılıf 249 TL");
    await ok("navigate", { tab, url: "reload" });
    await call("click", { tab, target: before });
    expect(await stateOf(tab)).toMatch(/\bfull\b/);
  });

  test("a ref from before a reload says the tab loaded a new page", async () => {
    const tab = await openRoute("/snapshot/cart");
    const before = refOf(await ok("snapshot", { tab, query: "Sil" }), "Silikon Kılıf 249 TL");
    await ok("navigate", { tab, url: "reload" });
    const result = await call("click", { tab, target: before });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      new RegExp(
        `^Ref ${before} cannot be used: tab t\\d+ loaded a new page since the snapshot it came from\\.[\\s\\S]*Take a new snapshot`,
      ),
    );
  });
});

async function deleteFirstRow(rows: string) {
  const tab = await openRoute(`/snapshot/cart-rows?${rows}`);
  const before = refOf(await ok("snapshot", { tab, query: "Sil" }), 'button "Sil"');
  await ok("click", { tab, target: before });
  return { tab, before };
}

describe("refs from an earlier page that must not be used again", () => {
  test("the button of a deleted row is not used on the page loaded without that row", async () => {
    const { tab, before } = await deleteFirstRow("rows=a:Kılıf A,b:Kılıf B&links");
    const result = await call("click", { tab, target: before });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/cannot be used: tab t\d+ loaded a new page/);
  });

  test("a refused ref of a deleted row leaves the next row in place", async () => {
    const { tab, before } = await deleteFirstRow("rows=a:Kılıf A,b:Kılıf B&links");
    await call("click", { tab, target: before });
    const state = await ok("read_page", { tab, target: "#state" });
    await ok("tabs", { close: [tab] });
    expect(state).toMatch(/rows: b\b/);
  });

  test("a button in an iframe is not used again after a reload", async () => {
    const tab = await openRoute("/snapshot/frames?frames=one,two");
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    const before = refOf(snapshot.slice(snapshot.indexOf("iframe")), 'button "Pay"');
    await ok("navigate", { tab, url: "reload" });
    await call("click", { tab, target: before });
    expect(await stateOf(tab)).toMatch(/\bnone\b/);
  });

  test("a button in an iframe that is gone is not used for the same button in another iframe", async () => {
    const tab = await openRoute("/snapshot/frames?frames=one,two");
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    const before = refOf(snapshot.slice(snapshot.indexOf("iframe")), 'button "Pay"');
    await ok("navigate", { tab, url: `${fixture().url}/snapshot/frames?frames=two` });
    const result = await call("click", { tab, target: before });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/cannot be used: tab t\d+ loaded a new page/);
  });

  test("a ref is not used again after the tab moved to another site", async () => {
    const tab = await openRoute("/snapshot/cart");
    const before = refOf(await ok("snapshot", { tab, query: "Sil" }), "Silikon Kılıf 249 TL");
    const other = fixture().url.replace("127.0.0.1", "localhost");
    await ok("navigate", { tab, url: `${other}/snapshot/cart` });
    const result = await call("click", { tab, target: before });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/cannot be used: tab t\d+ loaded a new page/);
  });

  test("wait_for hidden on a ref from before a page load says the element is hidden", async () => {
    const tab = await openRoute("/snapshot/cart");
    const before = refOf(await ok("snapshot", { tab, query: "Sil" }), "Silikon Kılıf 249 TL");
    await ok("navigate", { tab, url: "reload" });
    const waited = await ok("wait_for", { tab, target: before, state: "hidden", timeout_ms: 2000 });
    await ok("tabs", { close: [tab] });
    expect(waited).toMatch(new RegExp(`^${before} is hidden\\.$`, "m"));
  });

  test("wait_for detached on a ref with a document number from before a page load says the element is detached", async () => {
    const tab = await openRoute("/snapshot/cart");
    await ok("navigate", { tab, url: "reload" });
    const before = refOf(await ok("snapshot", { tab, query: "Sil" }), "Silikon Kılıf 249 TL");
    await ok("navigate", { tab, url: "reload" });
    const waited = await ok("wait_for", {
      tab,
      target: before,
      state: "detached",
      timeout_ms: 2000,
    });
    await ok("tabs", { close: [tab] });
    expect(waited).toMatch(new RegExp(`^${before} is detached\\.$`, "m"));
  });

  test("a click with a line diff remembers only the refs the diff and the clicked element show", async () => {
    const tab = await openRoute("/snapshot/list");
    await ok("click", { tab, target: "text=Add apple", include_diff: true });
    const remembered = [...mcp.deps.manager.getTab(tab).refs.values()].map(
      (issued) => `${issued.role} ${issued.name}`,
    );
    await ok("tabs", { close: [tab] });
    expect(remembered.toSorted()).toStrictEqual(["button Add apple", "link Apple", "listitem "]);
  });
});

async function cancelRefOfOrderA(route = "/snapshot/order?id=A") {
  const tab = await openRoute(route);
  const snapshot = await ok("snapshot", { tab });
  return { tab, cancel: refOf(snapshot, 'button "İptal et"'), next: refOf(snapshot, "Sonraki") };
}

async function stateOf(tab: string) {
  const state = await ok("read_page", { tab, target: "#state" });
  await ok("tabs", { close: [tab] });
  return state;
}

describe("refs from another address of the same site", () => {
  test("a ref from another order's page is not used after a navigation", async () => {
    const { tab, cancel } = await cancelRefOfOrderA();
    await ok("navigate", { tab, url: `${fixture().url}/snapshot/order?id=B` });
    const result = await call("click", { tab, target: cancel });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: tab t\d+ loaded a new page since the snapshot it came from\.[\s\S]*Take a new snapshot/,
    );
  });

  test("a refused ref from another order's page leaves that order alone", async () => {
    const { tab, cancel } = await cancelRefOfOrderA();
    await ok("navigate", { tab, url: `${fixture().url}/snapshot/order?id=B` });
    await call("click", { tab, target: cancel });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test("a ref is not used after the page moved to another address without loading", async () => {
    const { tab, cancel, next } = await cancelRefOfOrderA();
    await ok("click", { tab, target: next });
    const result = await call("click", { tab, target: cancel });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: the tab's address changed from \S+\/snapshot\/order\?id=A to \S+\/snapshot\/order\?id=B\.[\s\S]*Take a new snapshot/,
    );
  });

  test("a ref whose button the page kept across an address change does not act on the next order", async () => {
    const { tab, cancel, next } = await cancelRefOfOrderA();
    await ok("click", { tab, target: next });
    await call("click", { tab, target: cancel });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test("a ref whose button the page drew again after an address change does not act on the next order", async () => {
    const { tab, cancel, next } = await cancelRefOfOrderA("/snapshot/order?id=A&render");
    await ok("click", { tab, target: next });
    await call("click", { tab, target: cancel });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test("a ref is not used after a jump to an anchor changed the address", async () => {
    const { tab, cancel } = await cancelRefOfOrderA();
    await ok("evaluate", { tab, expression: "location.hash = 'items'" });
    await call("click", { tab, target: cancel });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test.skipIf(process.env.WEB_AGENT_ENGINE === "playwright")(
    "a ref from the page left by going back is not used on the page restored from the back/forward cache",
    async () => {
      const tab = await openRoute("/snapshot/order?id=A");
      await ok("snapshot", { tab });
      await ok("navigate", { tab, url: `${fixture().url}/snapshot/order?id=B` });
      const cancelB = refOf(await ok("snapshot", { tab }), 'button "İptal et"');
      expect(await ok("navigate", { tab, url: "back" })).toMatch(/back\/forward cache/);
      await call("click", { tab, target: cancelB });
      expect(await stateOf(tab)).toMatch(/\bopen\b/);
    },
  );

  test("a ref of a page left and then restored by going back is not used", async () => {
    const { tab, cancel } = await cancelRefOfOrderA();
    await ok("navigate", { tab, url: `${fixture().url}/snapshot/order?id=B` });
    await ok("snapshot", { tab });
    await ok("navigate", { tab, url: "back" });
    await call("click", { tab, target: cancel });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });
});

describe("refs whose element now shows another record", () => {
  test("a ref is not used after a hash route moved to the next order", async () => {
    const tab = await openRoute("/snapshot/hash-order#/order/A");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki") });
    await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test("a ref is not used after a hash route change and says the address changed", async () => {
    const tab = await openRoute("/snapshot/hash-order#/order/A");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki") });
    const result = await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: the tab's address changed from \S+#\/order\/A to \S+#\/order\/B\.[\s\S]*Take a new snapshot/,
    );
  });

  test("a ref inside an iframe is not used after the iframe moved to the next order", async () => {
    const tab = await openRoute("/snapshot/frame-order");
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki") });
    await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    expect(await stateOf(tab)).toMatch(/\bopen\b/);
  });

  test("a ref inside an iframe that moved to the next order says the iframe's address changed", async () => {
    const tab = await openRoute("/snapshot/frame-order");
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki") });
    const result = await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: its iframe's address changed from \S+\?id=A to \S+\?id=B\.[\s\S]*Take a new snapshot/,
    );
  });

  test("a card's ref is not used on the card drawn in its place for another product", async () => {
    const tab = await openRoute("/snapshot/cards");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, "Sadece B ve C") });
    await call("click", { tab, target: refOf(snapshot, 'button "Sepete ekle"') });
    expect(await stateOf(tab)).toMatch(/\bnone\b/);
  });
});

describe("refs whose surroundings changed text", () => {
  test("fill types every field and submits a form whose strength meter changed", async () => {
    const tab = await openRoute("/snapshot/signup");
    const snapshot = await ok("snapshot", { tab });
    await ok("fill", {
      tab,
      fields: [
        { target: refOf(snapshot, 'textbox "E-posta"'), value: "a@b.co" },
        { target: refOf(snapshot, 'textbox "Şifre"'), value: "correcthorse" },
      ],
      submit: refOf(snapshot, 'button "Kayıt ol"'),
    });
    expect(await stateOf(tab)).toMatch(/submitted/);
  });

  test("a comment form sends after its character counter changed", async () => {
    const tab = await openRoute("/snapshot/comment");
    const snapshot = await ok("snapshot", { tab });
    await ok("fill", { tab, target: refOf(snapshot, 'textbox "Yorum metni"'), value: "Harika" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Gönder"') });
    expect(await stateOf(tab)).toMatch(/sent/);
  });

  test("a cart dialog goes to checkout after its total changed", async () => {
    const tab = await openRoute("/snapshot/cart-dialog");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Artır"') });
    await ok("click", { tab, target: refOf(snapshot, 'button "Ödemeye geç"') });
    expect(await stateOf(tab)).toMatch(/checkout/);
  });

  test("a code field fills while the dialog's countdown ticks", async () => {
    const tab = await openRoute("/snapshot/otp");
    const snapshot = await ok("snapshot", { tab });
    await Bun.sleep(600);
    await ok("fill", { tab, target: refOf(snapshot, 'textbox "Kod"'), value: "123456" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Onayla"') });
    expect(await stateOf(tab)).toMatch(/verified 123456/);
  });

  test("a button in a row with a live clock clicks", async () => {
    const tab = await openRoute("/snapshot/clock");
    const snapshot = await ok("snapshot", { tab });
    await Bun.sleep(600);
    await ok("click", { tab, target: refOf(snapshot, 'button "Sepete ekle"') });
    expect(await stateOf(tab)).toMatch(/bought/);
  });
});

describe("wait_for hidden on a ref whose element is still on the page", () => {
  test("wait_for hidden waits for a button whose name counts up until it is removed", async () => {
    const tab = await openRoute("/snapshot/sending");
    const sending = refOf(await ok("snapshot", { tab }), "Gönderiliyor");
    await Bun.sleep(400);
    await ok("wait_for", { tab, target: sending, state: "hidden", timeout_ms: 5000 });
    expect(await stateOf(tab)).toMatch(/\bsent\b/);
  });

  test("wait_for detached waits for a button whose name counts up until it is removed", async () => {
    const tab = await openRoute("/snapshot/sending");
    const sending = refOf(await ok("snapshot", { tab }), "Gönderiliyor");
    await Bun.sleep(400);
    await ok("wait_for", { tab, target: sending, state: "detached", timeout_ms: 5000 });
    expect(await stateOf(tab)).toMatch(/\bsent\b/);
  });

  test("wait_for hidden waits for a button after the tab's address changed in place", async () => {
    const tab = await openRoute("/snapshot/sending?fixed");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Adım"') });
    await ok("wait_for", {
      tab,
      target: refOf(snapshot, "Gönderiliyor"),
      state: "hidden",
      timeout_ms: 5000,
    });
    expect(await stateOf(tab)).toMatch(/\bsent\b/);
  });
});

describe("refs whose element is hidden for a moment", () => {
  test("wait_for a load more button that hid while loading finds it again", async () => {
    const tab = await openRoute("/snapshot/load-more");
    const more = refOf(await ok("snapshot", { tab }), 'button "Daha fazla yükle"');
    await ok("click", { tab, target: more });
    const waited = await call("wait_for", { tab, target: more, timeout_ms: 5000 });
    await ok("tabs", { close: [tab] });
    expect(waited.text).toBe(`${more} is visible.`);
  });

  test("a click on a button hidden for a moment waits for it", async () => {
    const tab = await openRoute("/snapshot/locked");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: "text=Gizle" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Aç"') });
    expect(await stateOf(tab)).toMatch(/\bopened\b/);
  });

  test("a click on a button that ignores the pointer for a moment waits for it", async () => {
    const tab = await openRoute("/snapshot/locked");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: "text=Kilitle" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Basılı"') });
    expect(await stateOf(tab)).toMatch(/\bpressed\b/);
  });
});

describe("a ref next to a frozen iframe", () => {
  test("a ref click on the page goes through while a cross-site iframe is frozen", async () => {
    const tab = await openRoute("/snapshot/frozen-frame");
    await Bun.sleep(500);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await Bun.sleep(1500);
    await call("click", { tab, target: refOf(snapshot, 'button "Ana"') });
    expect(await stateOf(tab)).toMatch(/\bclicked\b/);
  });

  test("a ref click on a page button hidden for a moment waits for it while a cross-site iframe is frozen", async () => {
    const tab = await openRoute("/snapshot/frozen-frame");
    await Bun.sleep(500);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await Bun.sleep(1500);
    await ok("evaluate", {
      tab,
      expression:
        "(() => { const ana = document.querySelector('main button'); ana.hidden = true; setTimeout(() => { ana.hidden = false; }, 600); return 1; })()",
    });
    await call("click", { tab, target: refOf(snapshot, 'button "Ana"') });
    expect(await stateOf(tab)).toMatch(/\bclicked\b/);
  });

  test("a ref inside a frozen iframe says the iframe did not answer", async () => {
    const tab = await openRoute("/snapshot/frozen-frame");
    await Bun.sleep(500);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await Bun.sleep(1500);
    const result = await call("click", { tab, target: refOf(snapshot, 'button "Reklam"') });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/^Ref \w+ cannot be used: its iframe did not answer for \d+ s\./);
  });
});

describe("why a ref is refused", () => {
  test("a toggle's ref says its name changed", async () => {
    const tab = await openRoute("/snapshot/follow");
    const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    await ok("click", { tab, target: follow });
    const result = await call("click", { tab, target: follow });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: its button's name changed from "Takip et" to "Takibi bırak"\./,
    );
  });

  test("a ref whose element took another role says its role changed", async () => {
    const tab = await openRoute("/snapshot/follow");
    const next = refOf(await ok("snapshot", { tab }), 'button "Devam"');
    await ok("click", { tab, target: "text=Rolü kaldır" });
    const result = await call("click", { tab, target: next });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: its button "Devam" changed its role to link\./,
    );
  });

  test("a ref only another tab gave out says which tab gave it out", async () => {
    const first = await openRoute("/snapshot/list");
    const add = refOf(await ok("snapshot", { tab: first }), 'button "Add apple"');
    const second = await openRoute("/snapshot/list");
    const result = await call("click", { tab: second, target: add });
    await ok("tabs", { close: [first, second] });
    expect(result.text).toMatch(new RegExp(`it came from a snapshot of tab ${first}\\.`));
  });
});

const ROUNDS = Array.from({ length: 15 }, (_, index) => index);

async function timed<T>(work: () => Promise<T>) {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

const COLLECT_GARBAGE = `const cdp = await page.context().newCDPSession(page);
await cdp.send("HeapProfiler.enable");
await cdp.send("HeapProfiler.collectGarbage");
await cdp.send("HeapProfiler.collectGarbage");
await cdp.detach();`;

describe("refs on pages that keep changing", () => {
  test("each snapshot of a page that redraws 200 buttons every 150 ms takes under 1 s", async () => {
    const tab = await openRoute("/snapshot/churn");
    const took = await inSequence(ROUNDS.slice(0, 6), () =>
      timed(() => ok("snapshot", { tab, scope: "full" })),
    );
    await ok("tabs", { close: [tab] });
    expect(Math.max(...took)).toBeLessThan(1000);
  });

  test("a list drawn again 15 times keeps no more removed buttons alive than the last snapshot showed", async () => {
    const tab = await openRoute("/snapshot/redrawn-list");
    await inSequence(ROUNDS, async () => {
      const snapshot = await ok("snapshot", { tab, scope: "full" });
      const first = refOf(snapshot, 'button "Öğe 0 ');
      const second = refOf(snapshot, 'button "Öğe 1 ');
      await ok("hover", { tab, target: first });
      await ok("evaluate", {
        tab,
        expression: "document.querySelector('#list button').textContent = 'Yeni'",
      });
      await call("hover", { tab, target: first });
      await ok("evaluate", { tab, expression: "redraw()" });
      await ok("wait_for", { tab, target: second, state: "detached", timeout_ms: 2000 });
    });
    await ok("run_script", { tab, code: COLLECT_GARBAGE });
    const alive = await call("evaluate", { tab, expression: "removedAlive()" });
    await ok("tabs", { close: [tab] });
    expect(Number(alive.structured?.value)).toBeLessThanOrEqual(300);
  });

  test("wait_for detached on a redrawn button's ref says it is detached", async () => {
    const tab = await openRoute("/snapshot/churn");
    const row = refOf(await ok("snapshot", { tab, scope: "full" }), 'button "Satır 7"');
    const waited = await call("wait_for", {
      tab,
      target: row,
      state: "detached",
      timeout_ms: 2000,
    });
    await ok("tabs", { close: [tab] });
    expect(waited.text).toBe(`${row} is detached.`);
  });

  test("a renamed ref on a page of 10 000 buttons is refused within 1.5 s", async () => {
    const tab = await openRoute("/snapshot/many-buttons");
    const target = refOf(await ok("snapshot", { tab, query: "Hedef" }), 'button "Hedef"');
    await ok("evaluate", {
      tab,
      expression: "document.getElementById('target').textContent = 'Değişti'",
    });
    const took = await timed(() => call("hover", { tab, target }));
    await ok("tabs", { close: [tab] });
    expect(took).toBeLessThan(1500);
  });
});

describe("wait_for after a ref action", () => {
  test("wait_for finds another visible ref of the same snapshot", async () => {
    const tab = await openRoute("/snapshot/replace-state");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Yenile"') });
    const heading = refOf(snapshot, "heading");
    const waited = await call("wait_for", { tab, target: heading, timeout_ms: 2000 });
    await ok("tabs", { close: [tab] });
    expect(waited.text).toBe(`${heading} is visible.`);
  });

  test("wait_for hidden on another visible ref of the same snapshot waits for it", async () => {
    const tab = await openRoute("/snapshot/replace-state");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Yenile"') });
    const result = await call("wait_for", {
      tab,
      target: refOf(snapshot, "heading"),
      state: "hidden",
      timeout_ms: 1000,
    });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/did not become hidden within 1 s/);
  });
});

async function deleteRowA(route: string) {
  const tab = await openRoute(route);
  const sil = refOf(await ok("snapshot", { tab, query: "Sil" }), "Kılıf A");
  await ok("click", { tab, target: sil });
  return { tab, sil };
}

describe("refs on a list drawn again", () => {
  test("a deleted row's ref does not delete the row drawn in its place", async () => {
    const { tab, sil } = await deleteRowA("/snapshot/rows");
    await call("click", { tab, target: sil });
    expect(await stateOf(tab)).toMatch(/deleted Kılıf A/);
  });

  test("a deleted row's ref says its button is gone", async () => {
    const { tab, sil } = await deleteRowA("/snapshot/rows");
    const result = await call("click", { tab, target: sil });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/cannot be used: its button "Sil" is gone from the page/);
  });
});

describe("refs inside an iframe that loaded another page", () => {
  test("a button of the iframe's earlier page does not click the same button on its new page", async () => {
    const tab = await openRoute("/snapshot/frame-swap");
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Değiştir"') });
    await ok("evaluate", {
      tab,
      expression:
        "new Promise((done) => { const frame = document.getElementById('frame'); const check = () => frame.contentDocument?.querySelector('button') && frame.contentWindow.location.search.includes('two') ? done(true) : setTimeout(check, 20); check(); })",
    });
    await call("click", { tab, target: refOf(snapshot, 'button "Pay"') });
    expect(await stateOf(tab)).toMatch(/\bnone\b/);
  });
});

describe("refs inside an iframe that loaded another page say so", () => {
  test("a button of the iframe's earlier page is refused because its iframe loaded a new page", async () => {
    const tab = await openRoute("/snapshot/frame-swap");
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Değiştir"') });
    await ok("evaluate", {
      tab,
      expression:
        "new Promise((done) => { const frame = document.getElementById('frame'); const check = () => frame.contentDocument?.querySelector('button') && frame.contentWindow.location.search.includes('two') ? done(true) : setTimeout(check, 20); check(); })",
    });
    const result = await call("click", { tab, target: refOf(snapshot, 'button "Pay"') });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(
      /^Ref \w+ cannot be used: its iframe loaded a new page since the snapshot\./,
    );
  });
});

describe("refs inside iframes without an address", () => {
  test("a button in a srcdoc iframe is not used again after a reload", async () => {
    const tab = await openRoute("/snapshot/srcdoc");
    const pay = refOf(await ok("snapshot", { tab, scope: "full" }), 'button "Pay"');
    await ok("navigate", { tab, url: "reload" });
    const result = await call("click", { tab, target: pay });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/cannot be used: tab t\d+ loaded a new page/);
  });

  test("a refused button in a srcdoc iframe leaves the reloaded order unpaid", async () => {
    const tab = await openRoute("/snapshot/srcdoc");
    const pay = refOf(await ok("snapshot", { tab, scope: "full" }), 'button "Pay"');
    await ok("navigate", { tab, url: "reload" });
    await call("click", { tab, target: pay });
    expect(await stateOf(tab)).toMatch(/\bnone\b/);
  });
});

describe("refs of several tabs", () => {
  test("a tab's own ref is used while another tab gave out the same ref", async () => {
    const other = await openRoute("/snapshot/order?id=C");
    await ok("snapshot", { tab: other });
    const { tab, cancel } = await cancelRefOfOrderA();
    await ok("click", { tab, target: cancel });
    await ok("tabs", { close: [other] });
    expect(await stateOf(tab)).toMatch(/cancelled A/);
  });

  test("a ref only another tab gave out is not used on a tab that never gave it out", async () => {
    const first = await openRoute("/snapshot/list");
    const add = refOf(await ok("snapshot", { tab: first }), 'button "Add apple"');
    const second = await openRoute("/snapshot/list");
    const result = await call("click", { tab: second, target: add });
    await ok("tabs", { close: [first, second] });
    expect(result.text).toMatch(
      new RegExp(`Ref ${add} is not in the latest snapshot of tab ${second}`),
    );
  });
});

async function passwordRefOfSiteA() {
  const tab = await openRoute("/snapshot/login?site=A");
  const password = refOf(await ok("snapshot", { tab }), 'textbox "Şifre"');
  await ok("navigate", { tab, url: `${fixture().url}/snapshot/login?site=B` });
  return { tab, password };
}

async function passwordOf(tab: string) {
  const result = await call("evaluate", {
    tab,
    expression: "document.querySelector('#password').value",
  });
  await ok("tabs", { close: [tab] });
  return result.structured?.value;
}

describe("secrets typed through a ref from another address", () => {
  test("fill with a secret does not type it into another page's field", async () => {
    const { tab, password } = await passwordRefOfSiteA();
    await call("fill", { tab, target: password, secret: "fixture/site" });
    expect(await passwordOf(tab)).toBe("");
  });

  test("fill with a secret says the tab loaded a new page", async () => {
    const { tab, password } = await passwordRefOfSiteA();
    const result = await call("fill", { tab, target: password, secret: "fixture/site" });
    await ok("tabs", { close: [tab] });
    expect(result.text).toMatch(/cannot be used: tab t\d+ loaded a new page/);
  });

  test("secrets.fill in a script does not type it into another page's field", async () => {
    const { tab, password } = await passwordRefOfSiteA();
    await call("run_script", { tab, code: `await secrets.fill('${password}', 'fixture/site');` });
    expect(await passwordOf(tab)).toBe("");
  });
});

describe("snapshot diffs", () => {
  test("diff lists a repeated line that was added", async () => {
    const tab = await openRoute("/snapshot/list");
    await ok("snapshot", { tab });
    await ok("click", { tab, target: "text=Add apple" });
    expect(await ok("snapshot", { tab, diff: true })).toMatch(/^\+ - \/url: \/fruit$/m);
    await ok("tabs", { close: [tab] });
  });

  test("diff without an earlier snapshot says to take one first", async () => {
    const tab = await openRoute("/snapshot/list");
    expect((await call("snapshot", { tab, diff: true })).text).toMatch(
      /no earlier snapshot of tab t\d+[\s\S]*Take a snapshot first/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("diff after a page load says to take a full snapshot", async () => {
    const tab = await openRoute("/snapshot/list");
    await ok("snapshot", { tab });
    await ok("navigate", { tab, url: "reload" });
    expect((await call("snapshot", { tab, diff: true })).text).toMatch(
      /loaded a new page since the previous snapshot/,
    );
    await ok("tabs", { close: [tab] });
  });
});
