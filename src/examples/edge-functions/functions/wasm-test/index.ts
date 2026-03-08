import {
  ImageMagick,
  initializeImageMagick,
  MagickGeometry,
} from "npm:@imagemagick/magick-wasm@latest";
import z from "npm:zod";

await initializeImageMagick(
  await Deno.readFile(
    new URL(
      "magick.wasm",
      import.meta.resolve("npm:@imagemagick/magick-wasm@latest"),
    ),
  ),
);

const QuerySchema = z.object({
  image: z.string().url("'image' must be a valid URL"),
  width: z.coerce.number().int().min(1).max(2048).optional().default(100),
  height: z.coerce.number().int().min(1).max(2048).optional().default(100),
  mode: z.enum(["resize", "crop"]).default("resize"),
});

function parseParams(url: URL): z.infer<typeof QuerySchema> | Response {
  const result = QuerySchema.safeParse({
    image: url.searchParams.get("image"),
    width: url.searchParams.get("width") ?? undefined,
    height: url.searchParams.get("height") ?? undefined,
    mode: url.searchParams.get("mode") ?? undefined,
  });

  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join("; ");
    return new Response(messages, { status: 400 });
  }

  const { width, height } = result.data;
  if (!width && !height) {
    return new Response(
      "At least one of 'width' or 'height' must be provided.",
      { status: 400 },
    );
  }

  return result.data;
}

async function fetchImage(
  imageUrl: string,
): Promise<{ buffer: Uint8Array; contentType: string } | Response> {
  let res: globalThis.Response;
  try {
    res = await fetch(imageUrl);
  } catch {
    return new Response("Failed to fetch image from URL.", { status: 400 });
  }

  if (!res.ok) {
    return new Response(`Upstream returned ${res.status} for the image URL.`, {
      status: 400,
    });
  }

  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("image/")) {
    return new Response("URL does not point to an image.", { status: 400 });
  }

  return {
    buffer: new Uint8Array(await res.arrayBuffer()),
    contentType,
  };
}

function processImage(
  buffer: Uint8Array,
  params: { width?: number; height?: number; mode: "resize" | "crop" },
): Promise<Uint8Array> {
  const geometry = new MagickGeometry(params.width ?? 0, params.height ?? 0);
  geometry.ignoreAspectRatio = !!params.width && !!params.height;

  return new Promise<Uint8Array>((resolve) => {
    ImageMagick.read(buffer, (image) => {
      if (params.mode === "crop") {
        image.crop(geometry);
      } else {
        image.resize(geometry);
      }
      image.write((data) => resolve(data));
    });
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = parseParams(url);
  if (params instanceof Response) return params;

  const remote = await fetchImage(params.image);
  if (remote instanceof Response) return remote;

  const output = await processImage(remote.buffer, params);

  return new Response(output, {
    headers: { "Content-Type": remote.contentType },
  });
});
