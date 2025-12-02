// src/index.ts - Complete Worker with AdminAgent (FINAL)

import { AdminAgent } from './admin-agent';
import { D1Manager } from './storage/d1-manager';
import { Workspace } from './workspace/workspace';
import type { Env, OrionRPC } from './types';
import type { DurableObjectStub } from '@cloudflare/workers-types';

export { AdminAgent };

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
        await d1.createSession(sessionId, 'New Session');
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

      case '/api/execute-step':
        if (request.method === 'POST') {
          const { projectPath, stepNumber } = await request.json();
          const result = await stub.executeStep(projectPath, stepNumber);
          return jsonResponse(result);
        }
        break;

      case '/api/workflows':
        if (request.method === 'GET') {
          const result = await stub.listWorkflows();
          return jsonResponse(result);
        }
        break;

      case '/api/workflows/search':
        if (request.method === 'POST') {
          const { query } = await request.json();
          const result = await stub.searchWorkflows(query);
          return jsonResponse(result);
        }
        break;

      case '/api/workflows/create-project':
        if (request.method === 'POST') {
          const { workflowId, objective, adaptations } = await request.json();
          const result = await stub.createProjectFromWorkflow(workflowId, objective, adaptations);
          return jsonResponse(result);
        }
        break;

      case '/api/projects':
        if (request.method === 'GET') {
          const result = await stub.getProjects();
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

      // === NEW AGENT ENDPOINTS ===
      case '/api/agents':
        if (request.method === 'GET') {
          // List all available agents
          const agents = await stub.getStatus();
          return jsonResponse({ 
            agents: [], // This would be populated from AgentRegistry
            count: (agents as any).metrics?.availableAgents || 0 
          });
        }
        break;

      case '/api/admin/state':
        if (request.method === 'GET') {
          const status = await stub.getStatus();
          return jsonResponse(status);
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
        await d1.createSession(sessionId, 'New Session');
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

  try {
    switch (path) {
      case '/api/sessions':
        if (request.method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          const sessions = await d1.listSessions(limit);
          return jsonResponse({ sessions });
        }
        if (request.method === 'POST') {
          const { sessionId, title } = await request.json();
          if (!sessionId || !isValidSessionId(sessionId)) {
            return errorResponse('Valid sessionId required', 400);
          }
          const session = await d1.createSession(sessionId, title);
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

      case '/api/sessions/rename':
        if (request.method === 'POST') {
          const { sessionId, title } = await request.json();
          if (!sessionId || !title) return errorResponse('sessionId and title required', 400);
          await d1.updateSessionTitle(sessionId, title);
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
          console.log('[Worker] Workspace initialized successfully');
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
          version: '6.0.0-admin-orchestrator',
          architecture: 'Hub-and-Spoke Multi-Agent System',
          d1: d1Status,
          workspace: workspaceStatus,
          timestamp: new Date().toISOString(),
        });
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
