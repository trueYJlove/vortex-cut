import { describe, expect, it } from "vitest";
import { rendererSafe } from "../electron/main/ipc/shared.js";

describe("IPC shared rendererSafe", () => {
  it("strips uppercase and mixed-case sensitive keys across nested objects and arrays", () => {
    const input = {
      asset_id: "asset_1",
      display_name: "clip.mp4",
      status: "ready",
      Path: "C:\\private\\clip.mp4",
      Token: "secret-token",
      Authorization: "Bearer top-secret",
      API_KEY: "sk-1234",
      nested: {
        Absolute_Path: "/Users/alice/video.mp4",
        Secret: "s3cr3t",
        Stderr: "ffmpeg error",
        Traceback: "Traceback (most recent call last)...",
        Raw_Exception: "RuntimeError",
        keep: true,
      },
      items: [
        {
          model_id: "model_1",
          Root_Dir: "/var/data",
          UI_Token: "ui-1",
          Admin_Token: "admin-1",
          Database_Path: "/var/data/app.db",
        },
      ],
    };

    expect(rendererSafe(input)).toEqual({
      asset_id: "asset_1",
      display_name: "clip.mp4",
      status: "ready",
      nested: { keep: true },
      items: [{ model_id: "model_1" }],
    });
  });
});
