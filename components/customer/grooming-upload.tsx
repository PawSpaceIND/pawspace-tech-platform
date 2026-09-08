"use client";

import React, { useState, useEffect, useRef } from "react";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { enqueueOfflineTelemetry } from "../../lib/mobile/offline-queue";

export interface GroomingPhoto {
  dataUrl: string;
  format: string;
  capturedAt: number;
  source: "native_camera" | "native_gallery" | "web_upload";
}

export interface GroomingUploadProps {
  bookingId?: string;
  onCheckInPhotoUploaded?: (photo: GroomingPhoto) => void;
  onCompletionPhotoUploaded?: (photo: GroomingPhoto) => void;
  className?: string;
}

export default function GroomingUpload({
  bookingId = "UAT-GROOMING-SAMPLE",
  onCheckInPhotoUploaded,
  onCompletionPhotoUploaded,
  className = "",
}: GroomingUploadProps) {
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [checkInPhoto, setCheckInPhoto] = useState<GroomingPhoto | null>(null);
  const [completionPhoto, setCompletionPhoto] = useState<GroomingPhoto | null>(null);
  const [busyType, setBusyType] = useState<"checkin" | "completion" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isNative = typeof window !== "undefined" && Capacitor.isNativePlatform();

  const takePhoto = async (
    type: "checkin" | "completion",
    source: "camera" | "photos"
  ): Promise<GroomingPhoto | null> => {
    try {
      if (isNative) {
        const image = await Camera.getPhoto({
          quality: 90,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
        });

        if (!image.dataUrl) {
          throw new Error("No image data captured from camera");
        }

        return {
          dataUrl: image.dataUrl,
          format: image.format || "jpeg",
          capturedAt: Date.now(),
          source: source === "camera" ? "native_camera" : "native_gallery",
        };
      }

      // Web Fallback: Create file picker
      return await new Promise<GroomingPhoto | null>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        if (source === "camera") {
          input.capture = "environment";
        }

        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }

          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              dataUrl: String(reader.result || ""),
              format: file.type.replace("image/", "") || "jpeg",
              capturedAt: Date.now(),
              source: "web_upload",
            });
          };
          reader.onerror = () => reject(new Error("Failed to read selected image"));
          reader.readAsDataURL(file);
        };

        input.oncancel = () => resolve(null);
        input.click();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to capture photo";
      if (!message.includes("User cancelled") && !message.includes("cancel")) {
        throw new Error(message);
      }
      return null;
    }
  };

  const handleCapture = async (type: "checkin" | "completion", source: "camera" | "photos") => {
    setError(null);
    setSuccessMessage(null);
    setBusyType(type);

    try {
      const photo = await takePhoto(type, source);
      if (!photo) return;

      const purpose = type === "checkin" ? "before_service" : "after_service";
      const payload = {
        bookingId,
        purpose,
        dataUrl: photo.dataUrl,
        format: photo.format,
        capturedAt: photo.capturedAt,
      };

      // Check network status before attempting upload
      const networkStatus = await Network.getStatus().catch(() => ({ connected: true }));
      let isQueued = false;

      if (!networkStatus.connected) {
        await enqueueOfflineTelemetry({
          type: "grooming_photo",
          endpoint: "/api/service-media",
          payload,
        });
        isQueued = true;
      } else {
        try {
          const response = await fetch("/api/service-media", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok && response.status !== 404 && response.status !== 409) {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch {
          // If network call failed, enqueue offline telemetry
          await enqueueOfflineTelemetry({
            type: "grooming_photo",
            endpoint: "/api/service-media",
            payload,
          });
          isQueued = true;
        }
      }

      if (!isMountedRef.current) return;

      if (type === "checkin") {
        setCheckInPhoto(photo);
        onCheckInPhotoUploaded?.(photo);
      } else {
        setCompletionPhoto(photo);
        onCompletionPhotoUploaded?.(photo);
      }

      if (isQueued) {
        setSuccessMessage("Offline: Photo saved to local queue. Will sync automatically upon reconnection.");
      } else {
        setSuccessMessage(
          type === "checkin"
            ? "Check-in photo captured successfully"
            : "Completion photo captured successfully"
        );
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : "Error capturing photo");
      }
    } finally {
      if (isMountedRef.current) {
        setBusyType(null);
      }
    }
  };

  const clearPhoto = (type: "checkin" | "completion") => {
    if (!isMountedRef.current) return;
    if (type === "checkin") {
      setCheckInPhoto(null);
    } else {
      setCompletionPhoto(null);
    }
    setSuccessMessage(null);
  };

  return (
    <div
      className={`ps-grooming-upload ${className}`}
      style={{
        background: "#ffffff",
        border: "1px solid #e2d9eb",
        borderRadius: "16px",
        padding: "20px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#24133f",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 800,
              letterSpacing: "1.5px",
              color: "#7540aa",
              textTransform: "uppercase",
            }}
          >
            Service Proof Camera
          </span>
          <h3 style={{ margin: "4px 0 0", fontSize: "18px", fontWeight: 700 }}>
            Pet Grooming Photo Verification
          </h3>
        </div>
        <span
          style={{
            fontSize: "11px",
            padding: "4px 8px",
            borderRadius: "6px",
            background: isNative ? "#e8f5e9" : "#f3e8fd",
            color: isNative ? "#2e7d32" : "#6c39a8",
            fontWeight: 600,
          }}
        >
          {isNative ? "Capacitor Native Camera" : "Web Simulation Mode"}
        </span>
      </div>

      <p style={{ fontSize: "13px", color: "#665e70", margin: "0 0 20px" }}>
        Booking: <strong>{bookingId}</strong> · Capture high-resolution check-in and completion photos for verification and compliance.
      </p>

      {error && (
        <div
          role="alert"
          style={{
            background: "#ffebee",
            border: "1px solid #ffcdd2",
            color: "#c62828",
            borderRadius: "8px",
            padding: "10px 14px",
            fontSize: "13px",
            marginBottom: "16px",
          }}
        >
          {error}
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          style={{
            background: "#e8f5e9",
            border: "1px solid #c8e6c9",
            color: "#2e7d32",
            borderRadius: "8px",
            padding: "10px 14px",
            fontSize: "13px",
            marginBottom: "16px",
          }}
        >
          {successMessage}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        {/* Check-in / Before Photo */}
        <div
          style={{
            border: "1px dashed #d1c4e0",
            borderRadius: "12px",
            padding: "16px",
            background: "#faf8fc",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "8px" }}>
            1. Check-in Photo (Before)
          </div>
          {checkInPhoto ? (
            <div style={{ width: "100%", textAlign: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={checkInPhoto.dataUrl}
                alt="Grooming check-in preview"
                style={{
                  width: "100%",
                  maxHeight: "160px",
                  objectFit: "cover",
                  borderRadius: "8px",
                  border: "1px solid #e0d6eb",
                }}
              />
              <div style={{ marginTop: "8px", fontSize: "11px", color: "#555" }}>
                Captured: {new Date(checkInPhoto.capturedAt).toLocaleTimeString()} · {checkInPhoto.source}
              </div>
              <button
                type="button"
                onClick={() => clearPhoto("checkin")}
                style={{
                  marginTop: "8px",
                  padding: "6px 12px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "1px solid #c9bce0",
                  background: "#fff",
                  color: "#d32f2f",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Retake
              </button>
            </div>
          ) : (
            <div style={{ width: "100%", textAlign: "center" }}>
              <div
                style={{
                  height: "120px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#8b8198",
                  fontSize: "13px",
                }}
              >
                No photo captured yet
              </div>
              <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
                <button
                  type="button"
                  disabled={busyType === "checkin"}
                  onClick={() => handleCapture("checkin", "camera")}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#4b168c",
                    color: "#fff",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: busyType === "checkin" ? "not-allowed" : "pointer",
                  }}
                >
                  {busyType === "checkin" ? "Opening Camera..." : "📷 Camera"}
                </button>
                <button
                  type="button"
                  disabled={busyType === "checkin"}
                  onClick={() => handleCapture("checkin", "photos")}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "8px",
                    border: "1px solid #d1c4e0",
                    background: "#fff",
                    color: "#4b168c",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: busyType === "checkin" ? "not-allowed" : "pointer",
                  }}
                >
                  📁 Gallery
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Completion / After Photo */}
        <div
          style={{
            border: "1px dashed #d1c4e0",
            borderRadius: "12px",
            padding: "16px",
            background: "#faf8fc",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "8px" }}>
            2. Completion Photo (After)
          </div>
          {completionPhoto ? (
            <div style={{ width: "100%", textAlign: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={completionPhoto.dataUrl}
                alt="Grooming completion preview"
                style={{
                  width: "100%",
                  maxHeight: "160px",
                  objectFit: "cover",
                  borderRadius: "8px",
                  border: "1px solid #e0d6eb",
                }}
              />
              <div style={{ marginTop: "8px", fontSize: "11px", color: "#555" }}>
                Captured: {new Date(completionPhoto.capturedAt).toLocaleTimeString()} · {completionPhoto.source}
              </div>
              <button
                type="button"
                onClick={() => clearPhoto("completion")}
                style={{
                  marginTop: "8px",
                  padding: "6px 12px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "1px solid #c9bce0",
                  background: "#fff",
                  color: "#d32f2f",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Retake
              </button>
            </div>
          ) : (
            <div style={{ width: "100%", textAlign: "center" }}>
              <div
                style={{
                  height: "120px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#8b8198",
                  fontSize: "13px",
                }}
              >
                No photo captured yet
              </div>
              <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
                <button
                  type="button"
                  disabled={busyType === "completion"}
                  onClick={() => handleCapture("completion", "camera")}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#4b168c",
                    color: "#fff",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: busyType === "completion" ? "not-allowed" : "pointer",
                  }}
                >
                  {busyType === "completion" ? "Opening Camera..." : "📷 Camera"}
                </button>
                <button
                  type="button"
                  disabled={busyType === "completion"}
                  onClick={() => handleCapture("completion", "photos")}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "8px",
                    border: "1px solid #d1c4e0",
                    background: "#fff",
                    color: "#4b168c",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: busyType === "completion" ? "not-allowed" : "pointer",
                  }}
                >
                  📁 Gallery
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
