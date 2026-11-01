import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { admitEncodedImages } from "@deepseek-ai/dsh-attachment";
import { NativeError } from "./dsh-cua.js";
async function saveScreenshotArtifact(attachments, fs, screenshot, signal) {
  signal.throwIfAborted();
  const refs = await admitEncodedImages(attachments, [{ data: screenshot.data, mediaType: screenshot.mimeType }]);
  signal.throwIfAborted();
  const attachment = refs[0];
  if (!attachment) throw new NativeError("NATIVE_PROTOCOL", "Screenshot admission returned no image");
  const original = attachment.originalDimensions ?? attachment;
  if (original.width !== screenshot.pixelWidth || original.height !== screenshot.pixelHeight) {
    throw new NativeError("NATIVE_PROTOCOL", "Native screenshot dimensions disagree with its decoded image");
  }
  const image = await attachments.readImage(attachment, signal);
  signal.throwIfAborted();
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[image.ref.mediaType];
  const file = await attachments.saveFile({ data: image.data, name: `cua-screenshot-${randomUUID()}.${extension}` });
  signal.throwIfAborted();
  const hostPath = attachments.fileHostPath(file);
  const path = hostPath === void 0 ? void 0 : fs.processPathFromHostPath(hostPath);
  if (path === void 0) throw new NativeError("ARTIFACT_UNAVAILABLE", "The current task cannot read the screenshot file from this attachment store");
  const target = await fs.resolve(path, { signal });
  const displayPath = fs.processPath(target);
  const entry = await fs.lstat(displayPath, void 0, signal);
  const info = await fs.stat(target, signal);
  signal.throwIfAborted();
  if (entry?.type !== "file" || info?.type !== "file" || info.size !== file.bytes) {
    throw new NativeError("ARTIFACT_UNAVAILABLE", "The saved screenshot file is unavailable in the current task");
  }
  const readable = await fs.readBytes(target, signal, file.bytes);
  signal.throwIfAborted();
  if (!Buffer.from(readable).equals(image.data)) throw new NativeError("ARTIFACT_UNAVAILABLE", "The screenshot file does not match its stored image");
  return {
    path: displayPath,
    mimeType: image.ref.mediaType,
    pixelWidth: image.ref.width,
    pixelHeight: image.ref.height,
    windowId: screenshot.windowId,
    purpose: "User screenshot artifact; the model has not seen its pixels.",
    modelReceivedImage: false
  };
}
export {
  saveScreenshotArtifact
};
