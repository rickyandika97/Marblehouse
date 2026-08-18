"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2, MapPin, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Clock-in flow (§8.9): shift → camera → location → upload.
 *
 * **The photo is captured live from the camera** via `getUserMedia`, drawn to a
 * canvas and posted as a blob (§4.13). There is deliberately no file input and
 * no gallery path: the whole point of the photo is that it was taken here, now.
 *
 * Location is requested at the moment of capture. A denial does NOT block the
 * clock-in — it is recorded, flagged, and stamped `LOCATION UNAVAILABLE` on the
 * image by the server. Blocking would mean a staff member cannot start their
 * shift because of a browser permission prompt.
 */
interface ShiftOption {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  wouldBeLate: boolean;
  wouldBeLateMinutes: number;
}

type Step = "shift" | "camera" | "confirm";

export function ClockInFlow({
  shopName,
  shifts,
  alreadyClockedIn,
  record,
  doneHref,
}: {
  shopName: string;
  shifts: ShiftOption[];
  alreadyClockedIn: boolean;
  record: { clockInAt: string; isLate: boolean; lateMinutes: number } | null;
  /**
   * Where the Back / Done buttons go — the caller's role landing path, NOT a
   * hardcoded /dashboard. Staff have no dashboard (D-113).
   */
  doneHref: string;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [step, setStep] = useState<Step>(shifts.length > 0 ? "shift" : "camera");
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [shot, setShot] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    photoUrl: string;
    isLate: boolean;
    lateMinutes: number;
    locationDenied: boolean;
  } | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Release the camera on unmount. A tablet whose camera light stays on after
  // the user navigates away looks broken and drains the battery.
  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch {
      setCameraError(
        "The camera could not be opened. Allow camera access in your browser settings, then try again."
      );
    }
  }, []);

  useEffect(() => {
    if (step === "camera" && !shot) void startCamera();
    if (step !== "camera") stopCamera();
  }, [step, shot, startCamera, stopCamera]);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast.error("The photo could not be taken. Try again.");
          return;
        }
        setShot(blob);
        setPreview(URL.createObjectURL(blob));
        stopCamera();
        setStep("confirm");
      },
      "image/jpeg",
      0.9
    );
  }

  function retake() {
    if (preview) URL.revokeObjectURL(preview);
    setShot(null);
    setPreview(null);
    setStep("camera");
  }

  /** Ask for location, resolving to null rather than rejecting on denial. */
  function getPosition(): Promise<GeolocationPosition | null> {
    if (!("geolocation" in navigator)) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    });
  }

  async function submit() {
    if (!shot || submitting) return;
    setSubmitting(true);

    try {
      const position = await getPosition();

      const form = new FormData();
      form.append("photo", shot, "clock-in.jpg");
      if (shiftId) form.append("shiftId", shiftId);

      if (position) {
        form.append("latitude", String(position.coords.latitude));
        form.append("longitude", String(position.coords.longitude));
        form.append(
          "accuracyM",
          String(Math.round(position.coords.accuracy ?? 0))
        );
        form.append("locationDenied", "false");
      } else {
        form.append("locationDenied", "true");
      }

      const response = await fetch("/api/attendance/clock-in", {
        method: "POST",
        body: form,
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not clock in.");
        return;
      }

      setResult(body);
      router.refresh();
    } catch {
      toast.error("No connection. Check the wifi and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (alreadyClockedIn && !result) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Already clocked in</h1>
        <div className="rounded-xl border p-4">
          <p className="text-sm">
            You clocked in at{" "}
            <strong>
              {record
                ? new Date(record.clockInAt).toLocaleTimeString("id-ID", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—"}
            </strong>
            {record?.isLate ? (
              <span className="text-red-600">
                {" "}
                · {record.lateMinutes} minutes late
              </span>
            ) : null}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Only one clock-in is recorded per day. Ask the owner if this needs
            correcting.
          </p>
        </div>
        <Button render={<a href={doneHref} />} size="lg" className="w-full">
          Back
        </Button>
      </div>
    );
  }

  if (result) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">You are clocked in</h1>

        <div
          className={cn(
            "rounded-xl border p-4",
            result.isLate ? "border-red-300 bg-red-50" : "border-emerald-300 bg-emerald-50"
          )}
        >
          <p className="font-semibold">
            {result.isLate
              ? `Recorded as ${result.lateMinutes} minutes late`
              : "Recorded on time"}
          </p>
          {result.locationDenied && (
            <p className="mt-1 text-sm">
              Location was unavailable, so this record is flagged for the owner.
            </p>
          )}
        </div>

        {/* §8.9: the confirmation shows the WATERMARKED photo, not the raw
            capture — so staff can see exactly what was recorded. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={result.photoUrl}
          alt="Your clock-in photo"
          className="w-full rounded-xl border"
        />

        <Button render={<a href={doneHref} />} size="lg" className="w-full">
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Clock in</h1>
        <p className="mt-1 text-sm text-muted-foreground">{shopName}</p>
      </div>

      {step === "shift" && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Which shift are you working?</p>
          <ul className="space-y-2">
            {shifts.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setShiftId(s.id);
                    setStep("camera");
                  }}
                  className="flex min-h-16 w-full items-center gap-3 rounded-xl border p-4 text-left hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {s.startTime} – {s.endTime}
                    </p>
                  </div>
                  {s.wouldBeLate && (
                    <span className="shrink-0 text-sm font-semibold text-red-600">
                      {s.wouldBeLateMinutes} min late
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {/* §8.11: this is the ONLY route through the screen for someone
              working an unscheduled shift, so it has to clear the 44px floor
              like the cards above — a text link would be the one control with
              no larger equivalent anywhere. Kept visually secondary (no border,
              muted) so it does not compete with the real shift options. */}
          <button
            type="button"
            onClick={() => setStep("camera")}
            className="min-h-11 w-full rounded-xl px-4 text-sm text-muted-foreground underline hover:bg-muted"
          >
            No shift applies — clock in anyway
          </button>
        </div>
      )}

      {step === "camera" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Your photo is stamped with the time, this branch and your location.
            Take it where you are standing now.
          </p>

          <div className="overflow-hidden rounded-xl border bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              className="aspect-[4/3] w-full object-cover"
            />
          </div>

          {cameraError ? (
            <div className="space-y-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
              <p>{cameraError}</p>
              <Button variant="outline" onClick={() => void startCamera()}>
                Try the camera again
              </Button>
            </div>
          ) : (
            <Button size="xl" className="w-full" onClick={capture}>
              <Camera className="size-5" />
              Take photo
            </Button>
          )}
        </div>
      )}

      {step === "confirm" && preview && (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Your clock-in photo"
            className="w-full rounded-xl border"
          />

          <div className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Your location is requested when you confirm. If you decline, you
              can still clock in — the record is flagged for the owner.
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={retake}>
              <RotateCcw className="size-4" />
              Retake
            </Button>
            <Button
              size="lg"
              className="flex-1"
              onClick={submit}
              disabled={submitting}
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Clock in
            </Button>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
