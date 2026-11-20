const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 600)); });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 600), e.stack?.slice(0, 800)));
await page.goto("http://localhost:4173/app/?example=plate-with-hole-shell");
await page.waitForTimeout(10000);
console.log("run buttons", await page.getByRole("button", { name: /Run static solve/ }).count());
await browser.close();
