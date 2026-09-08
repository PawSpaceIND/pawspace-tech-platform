import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";

export interface CapturedPhoto {
  dataUrl?: string;
  base64String?: string;
  format: string;
}

export async function capturePhoto(options?: {
  quality?: number;
  source?: "camera" | "photos";
}): Promise<CapturedPhoto> {
  const quality = options?.quality ?? 90;
  const source = options?.source === "photos" ? CameraSource.Photos : CameraSource.Camera;

  if (Capacitor.isNativePlatform()) {
    const image = await Camera.getPhoto({
      quality,
      allowEditing: false,
      resultType: CameraResultType.DataUrl,
      source,
    });

    return {
      dataUrl: image.dataUrl,
      base64String: image.base64String,
      format: image.format,
    };
  }

  // Web fallback using file input
  if (typeof document === "undefined") {
    throw new Error("Camera capture is not supported in this environment");
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (source === CameraSource.Camera) {
      input.capture = "environment";
    }

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error("No photo selected"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve({
          dataUrl: result,
          format: file.type.replace("image/", ""),
        });
      };
      reader.onerror = () => reject(new Error("Failed to read captured image"));
      reader.readAsDataURL(file);
    };

    input.click();
  });
}
