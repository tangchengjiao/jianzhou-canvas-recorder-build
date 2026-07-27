export type CameraPhase =
  | "idle"
  | "armed"
  | "drawing"
  | "hold"
  | "returning";

export type CameraStrength = "gentle" | "standard" | "strong";

export type CameraSnapshot = {
  zoom: number;
  focusX: number;
  focusY: number;
  phase: CameraPhase;
};

const ZOOM_BY_STRENGTH: Record<CameraStrength, number> = {
  gentle: 1.25,
  standard: 1.4,
  strong: 1.6,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const easeAlpha = (deltaMs: number, timeConstantMs: number) =>
  1 - Math.exp(-Math.max(0, deltaMs) / timeConstantMs);

export class CameraPlanner {
  private enabled = true;
  private strength: CameraStrength = "standard";
  private phase: CameraPhase = "idle";
  private currentZoom = 1;
  private targetZoom = 1;
  private currentFocusX = 0.5;
  private currentFocusY = 0.5;
  private targetFocusX = 0.5;
  private targetFocusY = 0.5;
  private holdUntil = 0;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.phase = "returning";
      this.targetZoom = 1;
      this.targetFocusX = 0.5;
      this.targetFocusY = 0.5;
    }
  }

  setStrength(strength: CameraStrength) {
    this.strength = strength;
    if (this.phase === "drawing" || this.phase === "hold") {
      this.targetZoom = ZOOM_BY_STRENGTH[strength];
    }
  }

  arm() {
    if (!this.enabled) return;
    this.phase = "armed";
  }

  move(focusX: number, focusY: number, distanceFromStartPx: number) {
    if (!this.enabled || this.phase === "idle" || this.phase === "returning") {
      return;
    }

    if (this.phase === "armed") {
      if (distanceFromStartPx < 10) return;
      this.phase = "drawing";
      this.targetZoom = ZOOM_BY_STRENGTH[this.strength];
    }

    if (this.phase !== "drawing") return;
    this.updateFocusWithSafeZone(focusX, focusY);
  }

  release(now = performance.now()) {
    if (this.phase === "armed") {
      this.phase = "idle";
      return;
    }

    if (this.phase === "drawing") {
      this.phase = "hold";
      this.holdUntil = now + 1_050;
    }
  }

  reset() {
    this.phase = "idle";
    this.currentZoom = 1;
    this.targetZoom = 1;
    this.currentFocusX = 0.5;
    this.currentFocusY = 0.5;
    this.targetFocusX = 0.5;
    this.targetFocusY = 0.5;
    this.holdUntil = 0;
  }

  tick(now: number, deltaMs: number): CameraSnapshot {
    if (this.phase === "hold" && now >= this.holdUntil) {
      this.phase = "returning";
      this.targetZoom = 1;
      this.targetFocusX = 0.5;
      this.targetFocusY = 0.5;
    }

    const zoomTimeConstant = this.targetZoom > this.currentZoom ? 170 : 280;
    const zoomAlpha = easeAlpha(deltaMs, zoomTimeConstant);
    const focusAlpha = easeAlpha(deltaMs, 150);

    this.currentZoom += (this.targetZoom - this.currentZoom) * zoomAlpha;
    this.currentFocusX +=
      (this.targetFocusX - this.currentFocusX) * focusAlpha;
    this.currentFocusY +=
      (this.targetFocusY - this.currentFocusY) * focusAlpha;

    const visibleHalf = 0.5 / Math.max(1, this.currentZoom);
    this.currentFocusX = clamp(
      this.currentFocusX,
      visibleHalf,
      1 - visibleHalf,
    );
    this.currentFocusY = clamp(
      this.currentFocusY,
      visibleHalf,
      1 - visibleHalf,
    );

    if (
      this.phase === "returning" &&
      Math.abs(this.currentZoom - 1) < 0.002 &&
      Math.abs(this.currentFocusX - 0.5) < 0.002 &&
      Math.abs(this.currentFocusY - 0.5) < 0.002
    ) {
      this.phase = "idle";
      this.currentZoom = 1;
      this.currentFocusX = 0.5;
      this.currentFocusY = 0.5;
    }

    return this.getSnapshot();
  }

  getSnapshot(): CameraSnapshot {
    return {
      zoom: this.currentZoom,
      focusX: this.currentFocusX,
      focusY: this.currentFocusY,
      phase: this.phase,
    };
  }

  private updateFocusWithSafeZone(pointerX: number, pointerY: number) {
    const visibleHalf = 0.5 / this.targetZoom;
    const safeHalf = visibleHalf * 0.6;

    if (pointerX > this.targetFocusX + safeHalf) {
      this.targetFocusX = pointerX - safeHalf;
    } else if (pointerX < this.targetFocusX - safeHalf) {
      this.targetFocusX = pointerX + safeHalf;
    }

    if (pointerY > this.targetFocusY + safeHalf) {
      this.targetFocusY = pointerY - safeHalf;
    } else if (pointerY < this.targetFocusY - safeHalf) {
      this.targetFocusY = pointerY + safeHalf;
    }

    this.targetFocusX = clamp(
      this.targetFocusX,
      visibleHalf,
      1 - visibleHalf,
    );
    this.targetFocusY = clamp(
      this.targetFocusY,
      visibleHalf,
      1 - visibleHalf,
    );
  }
}
