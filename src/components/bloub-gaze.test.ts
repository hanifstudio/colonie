import { describe, expect, it } from "vitest";
import {
  BLOUB_GAZE_MAX_PITCH,
  BLOUB_GAZE_MAX_YAW,
  BLOUB_GAZE_SOFT_RADIUS_PX,
  bloubLookForPointer,
} from "./bloub-gaze";

describe("bloubLookForPointer", () => {
  it("rests at the avatar center", () => {
    expect(bloubLookForPointer({ centerX: 100, centerY: 100, clientX: 100, clientY: 100 }))
      .toEqual({ yaw: 0, pitch: 0 });
  });

  it("pulls proportionally near the avatar", () => {
    const look = bloubLookForPointer({
      centerX: 0, centerY: 0,
      clientX: BLOUB_GAZE_SOFT_RADIUS_PX / 2,
      clientY: BLOUB_GAZE_SOFT_RADIUS_PX / 4,
    });
    expect(look.yaw).toBeCloseTo(BLOUB_GAZE_MAX_YAW / 2, 9);
    // pointer below center -> look down -> negative pitch (positive pitch is up)
    expect(look.pitch).toBeCloseTo(-BLOUB_GAZE_MAX_PITCH / 4, 9);
  });

  it("points the gaze at the pointer, not away from it", () => {
    // pointer up-right: eyes go up (positive pitch) and right (positive yaw)
    expect(bloubLookForPointer({ centerX: 0, centerY: 0, clientX: 5000, clientY: -5000 }))
      .toEqual({ yaw: BLOUB_GAZE_MAX_YAW, pitch: BLOUB_GAZE_MAX_PITCH });
    // pointer down-left: eyes go down (negative pitch) and left (negative yaw)
    expect(bloubLookForPointer({ centerX: 0, centerY: 0, clientX: -5000, clientY: 5000 }))
      .toEqual({ yaw: -BLOUB_GAZE_MAX_YAW, pitch: -BLOUB_GAZE_MAX_PITCH });
  });

  it("honours caller-supplied maxima", () => {
    expect(bloubLookForPointer({
      centerX: 0, centerY: 0, clientX: 9999, clientY: 9999,
      maxYaw: 10, maxPitch: 5,
    })).toEqual({ yaw: 10, pitch: -5 });
  });
});
