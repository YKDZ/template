export const PackageAdditionSupport = {
  Supported: "supported",
  Unsupported: "unsupported",
} as const;

export type PackageAdditionSupport =
  (typeof PackageAdditionSupport)[keyof typeof PackageAdditionSupport];
