// src/test/functions/_shared/cors.ts
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function withCors(body: string, status = 200): Response {
  return new Response(body, { status, headers: corsHeaders });
}
