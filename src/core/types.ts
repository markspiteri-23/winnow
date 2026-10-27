export type FileKind = "raw" | "jpeg";

export interface ShotFile {
  path: string;
  kind: FileKind;
}

/** One photo: a RAW+JPEG pair (or a single file) collapsed before any grouping or scoring. */
export interface Shot {
  /** Path of the primary file (RAW if present). */
  id: string;
  files: ShotFile[];
  /** ISO 8601 with milliseconds; offset only if the camera recorded one. Null if missing or implausible. */
  captureDate: string | null;
  cameraModel: string | null;
  iso: number | null;
  /** EXIF orientation 1-8, read from the RAW when there is one. */
  orientation: number | null;
  width: number | null;
  height: number | null;
  previewPath?: string;
  lowConfidence: boolean;
}

export interface FileError {
  path: string;
  error: string;
}

export type VerdictKind = "pick" | "reject" | "none";

/** Outcome for one shot, always explained. `score` 0-1 is only comparable within the shot's group. */
export interface Verdict {
  shotId: string;
  groupId: string;
  verdict: VerdictKind;
  score: number;
  reasons: string[];
}
