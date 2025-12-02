// src/index.ts - Refactored Worker with Session-Agnostic Architecture

import { AdminAgent } from './admin-agent-refactored';
import { D1Manager } from './storage/d1-manager-enhanced';
import { Workspace } from './workspace/workspace';
import type { Env, OrionRPC, ProjectFilters } from './types';
import type { DurableObjectStub } from '@cloudflare/workers-types';

export { AdminAgent };

// =============================================================
// Helper Functions
// =============================================================

function getSessionId(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get('session_id') || request.headers.get('X-Session-ID') || null;
}

function getUserId(request: Request): string | null {
  // In production: extract from JWT
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // TODO: Decode JWT and extract userId
    return null;
  }
  
  // Fallback: use session_id as user_id
  return getSessionId(request);
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
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
  const userId = getUserId(request);

  if (!sessionId) {
    return errorResponse('Session ID required', 400);
  }

  if (!isValidSessionId(sessionId)) {
    return errorResponse('Invalid session ID format', 400);
  }

  try {
    const id = env.AGENT.idFromName(`session:${sessionId}`);
    const stub = env.AGENT.get(id) as DurableObjectStub<OrionRPC>;

    // Ensure session exists in D1
    if (env.DB) {
      const d1 = new D1Manager(env.DB);
      const existing = await d1.getSession(sessionId);
      if (!existing) {
        await d1.createSession(sessionId, userId || undefined, 'New Session');
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Route handlers
    switch (path) {
      case '/api/chat':
        if (request.method === 'POST') {
          const { message, images } = await request.json();
          const result = await stub.chat(message, images);
          return jsonResponse(result);
        }
        break;

      case '/api/projects':
        if (request.method === 'GET') {
          const filters: ProjectFilters = {};
          const statusParam = url.searchParams.get('status');
          if (statusParam) filters.status = statusParam as any;
          
          const domainParam = url.searchParams.get('domain');
          if (domainParam) filters.domain = domainParam;
          
          const limitParam = url.searchParams.get('limit');
          if (limitParam) filters.limit = parseInt(limitParam, 10);
          
          const result = await stub.listProjects(filters);
          return jsonResponse(result);
        }
        break;

      case '/api/projects/get':
        if (request.method === 'GET') {
          const projectId = url.searchParams.get('projectId');
          if (!projectId) return errorResponse('projectId required', 400);
          
          const result = await stub.getProject(projectId);
          return jsonResponse(result);
        }
        break;

      case '/api/projects/continue':
        if (request.method === 'POST') {
          const { projectId } = await request.json();
          if (!projectId) return errorResponse('projectId required', 400);
          
          const result = await stub.continueProject(projectId);
          return jsonResponse(result);
        }
        break;

      case '/api/history':
        if (request.method === 'GET') {
          const result = await stub.getHistory();
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
  const userId = getUserId(request);

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
        await d1.createSession(sessionId, userId || undefined, 'New Session');
      }
    }

    return await stub.fetch(request);
  } catch (err: any) {
    console.error('[Worker] WebSocket routing error:', err);
    return errorResponse(err.message || 'WebSocket routing failed', 500);
  }
}

// =============================================================
// Session Management
// =============================================================

async function handleSessionManagement(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.DB) {
    return errorResponse('D1 database not configured', 500);
  }

  const d1 = new D1Manager(env.DB);
  const url = new URL(request.url);
  const path = url.pathname;
  const userId = getUserId(request);

  try {
    switch (path) {
      case '/api/sessions':
        if (request.method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          const sessions = await d1.listSessions(userId || undefined, limit);
          return jsonResponse({ sessions });
        }
        if (request.method === 'POST') {
          const { sessionId, title } = await request.json();
          if (!sessionId || !isValidSessionId(sessionId)) {
            return errorResponse('Valid sessionId required', 400);
          }
          const session = await d1.createSession(sessionId, userId || undefined, title);
          return jsonResponse({ session });
        }
        break;

      case '/api/sessions/delete':
        if (request.method === 'POST') {
          const { sessionId } = await request.json();
          if (!sessionId) return errorResponse('sessionId required', 400);
          await d1.deleteSession(sessionId);
          return jsonResponse({ ok: true });
        }
        break;
    }

    return new Response('Not Found', { status: 404 });
  } catch (err: any) {
    console.error('[Worker] Session management error:', err);
    return errorResponse(err.message || 'Session operation failed', 500);
  }
}

// =============================================================
// Admin Bootstrap Endpoint
// =============================================================

async function handleBootstrap(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // This endpoint would initialize workflow templates and agent definitions
  // Implementation depends on where you store initial templates
  
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    // TODO: Initialize workspace with default templates and agents
    return jsonResponse({ 
      message: 'Bootstrap complete',
      templatesCreated: 0,
      agentsCreated: 0,
    });
  } catch (err: any) {
    console.error('[Worker] Bootstrap error:', err);
    return errorResponse(err.message || 'Bootstrap failed', 500);
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

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
        },
      });
    }

    try {
      // Initialize workspace once
      if (!Workspace.isInitialized() && env.B2_KEY_ID && env.B2_APPLICATION_KEY) {
        try {
          Workspace.initialize(env);
          console.log('[Worker] Workspace initialized');
        } catch (e) {
          console.warn('[Worker] Workspace initialization failed:', e);
        }
      }

      // Health check
      if (path === '/' || path === '/health') {
        let d1Status = { enabled: false, healthy: false };
        let workspaceStatus = { enabled: false, initialized: false };

        if (env.DB) {
          const d1 = new D1Manager(env.DB);
          d1Status = {
            enabled: true,
            healthy: await d1.healthCheck(),
          };
        }

        workspaceStatus = {
          enabled: !!(env.B2_KEY_ID && env.B2_APPLICATION_KEY),
          initialized: Workspace.isInitialized(),
        };

        return jsonResponse({
          status: 'ok',
          name: 'ORION AI-Collaborator',
          version: '7.0.0-session-agnostic',
          architecture: 'Session-Agnostic Multi-Agent System',
          d1: d1Status,
          workspace: workspaceStatus,
          timestamp: new Date().toISOString(),
        });
      }

      // Bootstrap endpoint
      if (path === '/api/admin/bootstrap') {
        return await handleBootstrap(request, env, ctx);
      }

      // WebSocket upgrade
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return await routeToWebSocket(request, env, ctx);
      }

      // Session management routes
      if (path.startsWith('/api/sessions')) {
        return await handleSessionManagement(request, env, ctx);
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
