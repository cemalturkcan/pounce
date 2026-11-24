import { describe, expect, test } from "bun:test";
import { serviceUnit } from "./service.ts";

const lines = (unit: string) => unit.split("\n");

describe("a unit for a session that reaches graphical-session.target", () => {
  const unit = serviceUnit(["/opt/pounce"], { DISPLAY: ":0" }, true);

  test("is wanted by graphical-session.target", () => {
    expect(lines(unit)).toContain("WantedBy=graphical-session.target");
  });

  test("takes the display from the session", () => {
    expect(lines(unit).some((line) => line.startsWith("Environment=DISPLAY"))).toBe(false);
  });
});

describe("a unit for a session without graphical-session.target", () => {
  const unit = serviceUnit(
    ["/opt/pounce"],
    { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1", XAUTHORITY: "/run/user/1000/xauth" },
    false,
  );

  test("is wanted by default.target", () => {
    expect(lines(unit)).toContain("WantedBy=default.target");
  });

  test("is not tied to graphical-session.target", () => {
    expect(unit).not.toContain("graphical-session.target");
  });

  test("carries the install's display", () => {
    expect(lines(unit)).toEqual(
      expect.arrayContaining([
        "Environment=DISPLAY=:1",
        "Environment=WAYLAND_DISPLAY=wayland-1",
        "Environment=XAUTHORITY=/run/user/1000/xauth",
      ]),
    );
  });
});

test("a unit installed without a display sets none", () => {
  expect(
    lines(serviceUnit(["/opt/pounce"], {}, false)).some((line) =>
      line.startsWith("Environment=DISPLAY"),
    ),
  ).toBe(false);
});

test("a % in the binary path is doubled in ExecStart", () => {
  expect(lines(serviceUnit(["/opt/100%/pounce"], {}, false))).toContain(
    "ExecStart=/opt/100%%/pounce --daemon",
  );
});

test("a $ in the program path is kept, since systemd does not expand it there", () => {
  expect(lines(serviceUnit(["/opt/$HOME/pounce"], {}, false))).toContain(
    'ExecStart="/opt/$HOME/pounce" --daemon',
  );
});

test("a $ in an argument is doubled in ExecStart", () => {
  expect(lines(serviceUnit(["/usr/bin/bun", "/opt/$HOME/server.ts"], {}, false))).toContain(
    'ExecStart=/usr/bin/bun "/opt/$$HOME/server.ts" --daemon',
  );
});

test("a % in a display variable is doubled", () => {
  expect(lines(serviceUnit(["/opt/pounce"], { XAUTHORITY: "/run/%h/xauth" }, false))).toContain(
    "Environment=XAUTHORITY=/run/%%h/xauth",
  );
});

test("a $ in a display variable is kept as written", () => {
  expect(lines(serviceUnit(["/opt/pounce"], { XAUTHORITY: "/run/$USER/xauth" }, false))).toContain(
    'Environment="XAUTHORITY=/run/$USER/xauth"',
  );
});
