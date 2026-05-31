import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createImageJob, pollJob, downloadJob, cancelJob, releaseJob } from "./labs69";
import { CancelledError, checkCancelled, isCancelled, registerJob, unregisterJob } from "../cancellation";

export interface ImageResult {
  /** Path to the png file. */
  filePath: string;
  /** Provider's job id (if supported) — used to chain into img2vid without re-uploading. */
  providerJobId?: string;
  /** Which provider made the image. */
  provider: string;
}

export interface ImageOptions {
  /** Optional per-channel style override appended to the image prompt. */
  styleOverride?: string | null;
  /** Stock/detail flows can opt out of the broad global image prompt when the
   * user's exact prompt needs to stay fully in control. */
  omitGlobalImagePrompt?: boolean;
  /** Per-channel aspect ratio — NULL → global IMAGE_RATIO. */
  aspectOverride?: string | null;
  /** Visual-continuity hint from the previous scene — appended to anchor the
   *  next image to the same subject/wardrobe/lighting. NULL = fresh shot. */
  continuitySuffix?: string | null;
}

/**
 * Generates one illustration for a scene.
 * Supports 69labs (default), Replicate (Flux), OpenAI Images, fal.ai.
 */
export async function generateImage(
  runId: string,
  scene: Scene,
  outDir: string,
  options: ImageOptions = {}
): Promise<ImageResult> {
  const configuredProvider = (getSetting("IMAGE_PROVIDER") || "69labs").toLowerCase();
  const provider = configuredProvider === "off" ? "69labs" : configuredProvider;
  const styleSuffix = options.omitGlobalImagePrompt ? "" : getPrompt("image_prompt");
  const styleOverride = options.styleOverride?.trim();
  const continuitySuffix = options.continuitySuffix?.trim();
  const finalPrompt = [scene.visual_prompt, continuitySuffix, styleSuffix, styleOverride]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join(", ");
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.png`;
  const filePath = path.join(outDir, fileName);

  checkCancelled(runId);
  log(runId, "info", `Image scene #${scene.index} (${provider})`, {
    stage: "image",
    data: { provider, prompt: finalPrompt.slice(0, 120) },
  });

  if (provider === "69labs") {
    const jobId = await labs69Image(runId, finalPrompt, filePath, options.aspectOverride);
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, providerJobId: jobId, provider };
  }
  if (provider === "replicate") {
    await replicateImage(finalPrompt, filePath, options.aspectOverride);
  } else if (provider === "openai") {
    await openaiImage(finalPrompt, filePath);
  } else if (provider === "fal") {
    await falImage(finalPrompt, filePath, options.aspectOverride);
  } else {
    throw new Error(`Unknown image provider: ${provider}`);
  }
  log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
  return { filePath, provider };
}

async function labs69Image(
  runId: string,
  prompt: string,
  outPath: string,
  aspectOverride?: string | null
): Promise<string> {
  const model = getSetting("IMAGE_MODEL") || undefined; // server default = imagen-4
  let aspectRatio = (aspectOverride && aspectOverride.trim()) || getSetting("IMAGE_RATIO") || undefined;

  // Imagen 4 only accepts 'square|portrait|landscape', not numeric ratios like '16:9'.
  // Safely map for the Imagen family.
  const isImagen = !model || /^imagen/i.test(model);
  if (isImagen && aspectRatio) {
    const map: Record<string, string> = {
      "16:9": "landscape", "21:9": "landscape", "4:3": "landscape", "3:2": "landscape",
      "1:1": "square",
      "9:16": "portrait", "9:21": "portrait", "3:4": "portrait", "2:3": "portrait",
    };
    aspectRatio = map[aspectRatio] ?? aspectRatio;
  }

  const resolution = getSetting("IMAGE_RESOLUTION") || undefined;

  // Retry: on timeout we cancel the stuck job first to free the concurrent slot.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let jobId: string | null = null;
    try {
      checkCancelled(runId); // before creating a paid job
      jobId = await createImageJob({ prompt, model, aspectRatio, resolution, runId });
      registerJob(runId, "images", jobId);
      log(
        runId,
        "debug",
        `69labs image job ${jobId.slice(0, 8)}… (model=${model ?? "default"}, aspect=${aspectRatio}, res=${resolution ?? "default"}, attempt=${attempt})`,
        { stage: "image" }
      );
      checkCancelled(runId); // before polling
      await pollJob("images", jobId, runId, "image");
      checkCancelled(runId); // after polling, before download
      await downloadJob("images", jobId, outPath, { keepBindingOnSuccess: true });
      unregisterJob(runId, jobId);
      return jobId;
    } catch (e) {
      if (jobId) unregisterJob(runId, jobId);

      if (isCancelled(runId) || e instanceof CancelledError) {
        if (jobId) {
          const cancelled = await cancelJob("images", jobId).catch(() => false);
          log(runId, "debug", `Cancelled image ${jobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "image",
          });
        }
        throw e instanceof CancelledError ? e : new CancelledError(`Run ${runId} cancelled`);
      }

      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);

      // On polling timeout — cancel the orphaned job to free its concurrency slot.
      // cancelJob() releases the key slot internally. For other error types
      // (poll itself failed, download failed) we still need to release the key
      // since the job is dead to us.
      if (jobId) {
        if (/polling timeout/i.test(msg)) {
          const cancelled = await cancelJob("images", jobId);
          log(runId, "debug", `Cancelled ${jobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "image",
          });
        } else {
          // Free the key slot even on non-timeout errors so retries don't pile up
          releaseJob(jobId);
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff to let slots thaw
        const delay = 5000 * attempt;
        log(runId, "warn", `image attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "image",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function replicateImage(prompt: string, outPath: string, aspectOverride?: string | null) {
  const token = getSetting("REPLICATE_API_TOKEN");
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const model = getSetting("IMAGE_MODEL") || "black-forest-labs/flux-schnell";
  const aspect = (aspectOverride && aspectOverride.trim()) || getSetting("IMAGE_RATIO") || "16:9";

  const create = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input: { prompt, aspect_ratio: aspect, output_format: "png" } }),
  });

  if (!create.ok) {
    throw new Error(`Replicate ${create.status}: ${(await create.text()).slice(0, 300)}`);
  }
  const json = (await create.json()) as { output?: string | string[] };
  const urlOrUrls = json.output;
  let imageUrl: string | undefined;
  if (typeof urlOrUrls === "string") imageUrl = urlOrUrls;
  else if (Array.isArray(urlOrUrls) && urlOrUrls.length > 0) imageUrl = urlOrUrls[0];
  if (!imageUrl) throw new Error(`Replicate returned no output: ${JSON.stringify(json).slice(0, 300)}`);

  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Failed to download image: ${img.status}`);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

async function openaiImage(prompt: string, outPath: string) {
  const key = getSetting("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "gpt-image-1";

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: "1792x1024", n: 1 }),
  });
  if (!resp.ok) throw new Error(`OpenAI image ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { data: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) {
    fs.writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
  } else if (item?.url) {
    const r = await fetch(item.url);
    fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
  } else {
    throw new Error("OpenAI image: empty output");
  }
}

async function falImage(prompt: string, outPath: string, aspectOverride?: string | null) {
  const key = getSetting("FAL_API_KEY");
  if (!key) throw new Error("FAL_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "fal-ai/flux/schnell";
  const aspect = (aspectOverride && aspectOverride.trim()) || getSetting("IMAGE_RATIO") || "16:9";

  const resp = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspect_ratio: aspect, output_format: "png" }),
  });
  if (!resp.ok) throw new Error(`fal ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { images?: { url: string }[] };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("fal: empty output");
  const img = await fetch(url);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}
