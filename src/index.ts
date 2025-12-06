// src/index.ts - Worker Entry Point

import { OrionAgent } from './durable-agent';
import { D1Manager } from './storage/d1-manager';
import type { Env, OrionRPC } from './types';
import type { DurableObjectStub } from '@cloudflare/workers-types';

export { OrionAgent };

// =============================================================
// Helper Functions
// =============================================================

function getSessionId(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get('session_id') || request.headers.get('X-Session-ID') || null;
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function errorResponse(error: string, status = 500): Response {
  return jsonResponse({ error }, status);
}

function isValidSessionId(sessionId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(sessionId);
}

// =============================================================
// RPC Routing
// =============================================================

async function routeToRPC(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const sessionId = getSessionId(request);

  if (!sessionId) {
    return errorResponse('Session ID required', 400);
  }

  if (!isValidSessionId(sessionId)) {
    return errorResponse('Invalid session ID format', 400);
  }

  try {
    // Get Durable Object stub
    const id = env.AGENT.idFromName(`session:${sessionId}`);
    const stub = env.AGENT.get(id) as DurableObjectStub<OrionRPC>;

    // Ensure session exists in D1
    if (env.DB) {
      const d1 = new D1Manager(env.DB);
      const existing = await d1.getSession(sessionId);
      if (!existing) {
        await d1.createSession(sessionId);
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    switch (path) {
      case '/api/chat':
        if (request.method === 'POST') {
          const { message, images } = await request.json();
          const result = await stub.chat(message, images);
          return jsonResponse(result);
        }
        break;

      case '/api/history':
        if (request.method === 'GET') {
          const result = await stub.getHistory();
          return jsonResponse(result);
        }
        break;

      case '/api/artifacts':
        if (request.method === 'GET') {
          const result = await stub.getArtifacts();
          return jsonResponse(result);
        }
        break;

      case '/api/clear':
        if (request.method === 'POST') {
          const result = await stub.clear();
          return jsonResponse(result);
        }
        break;

      case '/api/status':
        if (request.method === 'GET') {
          const result = await stub.getStatus();
          return jsonResponse(result);
        }
        break;

      case '/api/upload':
        if (request.method === 'POST') {
          const formData = await request.formData();
          const file = formData.get('file') as File;
          if (!file) return errorResponse('No file provided', 400);

          const buffer = await file.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

          const result = await stub.uploadFile(base64, file.type, file.name);
          return jsonResponse(result);
        }
        break;

      case '/api/files':
        if (request.method === 'GET') {
          const result = await stub.listFiles();
          return jsonResponse(result);
        }
        break;

      case '/api/files/delete':
        if (request.method === 'POST') {
          const { fileUri } = await request.json();
          if (!fileUri) return errorResponse('fileUri required', 400);
          const result = await stub.deleteFile(fileUri);
          return jsonResponse(result);
        }
        break;
    }

    return new Response('Not Found', { status: 404 });
  } catch (err: any) {
    console.error('[Worker] RPC error:', err);
    return errorResponse(err.message || 'RPC call failed', 500);
  }
}

// =============================================================
// WebSocket Routing
// =============================================================

async function routeToWebSocket(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const sessionId = getSessionId(request);

  if (!sessionId || !isValidSessionId(sessionId)) {
    return errorResponse('Valid session ID required for WebSocket', 400);
  }

  try {
    const id = env.AGENT.idFromName(`session:${sessionId}`);
    const stub = env.AGENT.get(id);

    // Ensure session in D1
    if (env.DB) {
      const d1 = new D1Manager(env.DB);
      const existing = await d1.getSession(sessionId);
      if (!existing) {
        await d1.createSession(sessionId);
      }
    }

    return await stub.fetch(request);
  } catch (err: any) {
    console.error('[Worker] WebSocket routing error:', err);
    return errorResponse(err.message || 'WebSocket routing failed', 500);
  }
}

// =============================================================
// Main Worker
// =============================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check
      if (path === '/' || path === '/health') {
        let d1Status = { enabled: false, healthy: false };
        if (env.DB) {
          const d1 = new D1Manager(env.DB);
          d1Status = {
            enabled: true,
            healthy: await d1.healthCheck(),
          };
        }

        // Check B2 configuration
        const b2Status = {
          configured: !!(
            env.B2_KEY_ID &&
            env.B2_APPLICATION_KEY &&
            env.B2_S3_ENDPOINT &&
            env.B2_BUCKET
          ),
          validation: {
            hasKeyId: !!env.B2_KEY_ID,
            hasAppKey: !!env.B2_APPLICATION_KEY,
            hasEndpoint: !!env.B2_S3_ENDPOINT,
            hasBucket: !!env.B2_BUCKET,
            hasBasePath: !!env.B2_BASE_PATH,
            endpointFormat: env.B2_S3_ENDPOINT ? 
              (String(env.B2_S3_ENDPOINT).startsWith('http') ? 'valid' : 'invalid (missing protocol)') : 
              'missing',
            endpointValue: env.B2_S3_ENDPOINT ? 
              String(env.B2_S3_ENDPOINT) : 
              'not set'
          }
        };

        return jsonResponse({
          status: 'ok',
          name: 'ORION AI-Collaborator',
          version: '2.1.0',
          architecture: 'Admin-Worker v2 with B2 Workspace',
          d1: d1Status,
          workspace: b2Status,
          timestamp: new Date().toISOString()
        });
      }

      // WebSocket upgrade
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return await routeToWebSocket(request, env, ctx);
      }

      // API routes
      if (path.startsWith('/api/')) {
        return await routeToRPC(request, env, ctx);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Worker] Unhandled error:', err);
      return errorResponse(err.message || 'Internal Server Error', 500);
    }
  },
};
