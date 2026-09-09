import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const assetsDir = path.resolve("assets");
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const logoPath = path.resolve("public/assets/pawspace-logo.jpeg");

async function generateBaseAssets() {
  console.log("Generating base Capacitor assets in", assetsDir);

  // Resize logo for icon (768 max dimension centered in 1024x1024)
  const resizedLogoForIcon = await sharp(logoPath)
    .resize(768, 768, { fit: "inside" })
    .toBuffer();

  const iconMeta = await sharp(resizedLogoForIcon).metadata();
  const iconLeft = Math.round((1024 - (iconMeta.width || 768)) / 2);
  const iconTop = Math.round((1024 - (iconMeta.height || 768)) / 2);

  // 1. icon.png (1024x1024) with white/brand background
  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: resizedLogoForIcon, left: iconLeft, top: iconTop }])
    .png()
    .toFile(path.join(assetsDir, "icon.png"));

  // 2. icon-only.png (1024x1024)
  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: resizedLogoForIcon, left: iconLeft, top: iconTop }])
    .png()
    .toFile(path.join(assetsDir, "icon-only.png"));

  // 3. icon-foreground.png (1024x1024)
  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resizedLogoForIcon, left: iconLeft, top: iconTop }])
    .png()
    .toFile(path.join(assetsDir, "icon-foreground.png"));

  // 4. icon-background.png (1024x1024)
  await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toFile(path.join(assetsDir, "icon-background.png"));

  // 5. splash.png (2732x2732)
  const resizedLogoForSplash = await sharp(logoPath)
    .resize(1200, 1200, { fit: "inside" })
    .toBuffer();

  const splashMeta = await sharp(resizedLogoForSplash).metadata();
  const splashLeft = Math.round((2732 - (splashMeta.width || 1200)) / 2);
  const splashTop = Math.round((2732 - (splashMeta.height || 1200)) / 2);

  await sharp({
    create: {
      width: 2732,
      height: 2732,
      channels: 4,
      background: { r: 1, g: 38, b: 31, alpha: 1 }, // #01261F
    },
  })
    .composite([{ input: resizedLogoForSplash, left: splashLeft, top: splashTop }])
    .png()
    .toFile(path.join(assetsDir, "splash.png"));

  // 6. splash-dark.png (2732x2732)
  await sharp({
    create: {
      width: 2732,
      height: 2732,
      channels: 4,
      background: { r: 1, g: 38, b: 31, alpha: 1 }, // #01261F
    },
  })
    .composite([{ input: resizedLogoForSplash, left: splashLeft, top: splashTop }])
    .png()
    .toFile(path.join(assetsDir, "splash-dark.png"));

  console.log("✔ Base assets generated successfully in assets/");
}

generateBaseAssets().catch((err) => {
  console.error("Failed to generate base assets:", err);
  process.exit(1);
});
