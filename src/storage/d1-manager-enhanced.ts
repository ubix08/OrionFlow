// src/storage/d1-manager-enhanced.ts - Enhanced D1 with Project Support

import type { Message, Session, ProjectMetadata, ProjectFilters } from '../types';

export class D1Manager {
  private db: D1Database;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(db: D1Database) {
    this.db = db;
  }

  // =============================================================
  // Initialization
  // =============================================================

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    
    if (this.initPromise) {
      return this.initPromise;
    }
    
    this.initPromise = this.initialize().then(() => {
      this.initialized = true;
    });
    
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    console.log('[D1] Initializing enhanced schema...');

    try {
      // Sessions table
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          user_id TEXT,
          title TEXT NOT NULL DEFAULT 'New Session',
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          message_count INTEGER DEFAULT 0,
          metadata TEXT DEFAULT '{}'
        )
      `).run();

      // Messages table
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'model', 'system')),
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          metadata TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `).run();

      // Projects table (NEW - Session-Agnostic)
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS projects (
          project_id TEXT PRIMARY KEY,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER DEFAULT 1,
          
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          domain TEXT,
          tags TEXT,
          
          status TEXT NOT NULL CHECK(status IN ('planning', 'active', 'paused', 'completed', 'failed')),
          current_step INTEGER DEFAULT 1,
          total_steps INTEGER DEFAULT 0,
          
          workflow_id TEXT,
          last_checkpoint INTEGER,
          checkpoint_data TEXT,
          
          metadata TEXT DEFAULT '{}'
        )
      `).run();

      // Project sessions (NEW)
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS project_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('created', 'resumed', 'continued', 'completed', 'failed')),
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        )
      `).run();

      // Artifacts table
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          project_id TEXT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          worker_type TEXT,
          created_at INTEGER NOT NULL,
          metadata TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        )
      `).run();

      // Indexes
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_msg_session_ts ON messages(session_id, timestamp)`).run();
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at DESC)`).run();
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_activity_at DESC)`).run();
      
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(created_by, updated_at DESC)`).run();
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(created_by, status, updated_at DESC)`).run();
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_projects_domain ON projects(domain)`).run();
      
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_proj_sessions ON project_sessions(project_id, timestamp DESC)`).run();
      await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_at DESC)`).run();

      console.log('[D1] Enhanced schema initialized');
    } catch (error) {
      console.error('[D1] Initialization failed:', error);
      this.initialized = false;
      this.initPromise = null;
      throw error;
    }
  }

  // =============================================================
  // Session Operations
  // =============================================================

  async createSession(sessionId: string, userId?: string, title?: string): Promise<Session> {
    await this.ensureInitialized();
    const now = Date.now();
    const sessionTitle = title || 'New Session';

    await this.db.prepare(`
      INSERT INTO sessions (session_id, user_id, title, created_at, last_activity_at, message_count, metadata)
      VALUES (?, ?, ?, ?, ?, 0, '{}')
      ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id
    `).bind(sessionId, userId || null, sessionTitle, now, now).run();

    return {
      sessionId,
      userId,
      title: sessionTitle,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      metadata: {},
    };
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.ensureInitialized();

    const row = await this.db.prepare(`
      SELECT * FROM sessions WHERE session_id = ?
    `).bind(sessionId).first<any>();

    if (!row) return null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      metadata: this.parseJson(row.metadata, {}),
    };
  }

  async listSessions(userId?: string, limit = 50): Promise<Session[]> {
    await this.ensureInitialized();

    const query = userId
      ? `SELECT * FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC LIMIT ?`
      : `SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?`;

    const result = userId
      ? await this.db.prepare(query).bind(userId, limit).all()
      : await this.db.prepare(query).bind(limit).all();

    return (result.results || []).map((row: any) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      metadata: this.parseJson(row.metadata, {}),
    }));
  }

  async updateSessionActivity(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE session_id = ?`).bind(Date.now(), sessionId).run();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run();
  }

  // =============================================================
  // Project Operations (NEW)
  // =============================================================

  async createProject(metadata: ProjectMetadata): Promise<void> {
    await this.ensureInitialized();

    await this.db.prepare(`
      INSERT INTO projects (
        project_id, created_by, created_at, updated_at, version,
        title, objective, domain, tags,
        status, current_step, total_steps,
        workflow_id, last_checkpoint, checkpoint_data,
        metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      metadata.projectId,
      metadata.createdBy,
      metadata.createdAt,
      metadata.updatedAt,
      metadata.version,
      metadata.title,
      metadata.objective,
      metadata.domain,
      JSON.stringify(metadata.tags),
      metadata.status,
      metadata.currentStep,
      metadata.totalSteps,
      metadata.workflowId || null,
      metadata.lastCheckpoint || null,
      metadata.checkpointData ? JSON.stringify(metadata.checkpointData) : null,
      '{}'
    ).run();
  }

  async getProject(projectId: string): Promise<ProjectMetadata | null> {
    await this.ensureInitialized();

    const row = await this.db.prepare(`
      SELECT * FROM projects WHERE project_id = ?
    `).bind(projectId).first<any>();

    if (!row) return null;

    // Load sessions
    const sessions = await this.getProjectSessions(projectId);

    return {
      projectId: row.project_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      
      title: row.title,
      objective: row.objective,
      domain: row.domain,
      tags: this.parseJson(row.tags, []),
      
      status: row.status,
      currentStep: row.current_step,
      totalSteps: row.total_steps,
      
      workflowId: row.workflow_id,
      lastCheckpoint: row.last_checkpoint,
      checkpointData: row.checkpoint_data ? this.parseJson(row.checkpoint_data, null) : undefined,
      
      sessions,
    };
  }

  async listProjects(filters: ProjectFilters = {}): Promise<ProjectMetadata[]> {
    await this.ensureInitialized();

    let query = 'SELECT * FROM projects WHERE 1=1';
    const params: any[] = [];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.domain) {
      query += ' AND domain = ?';
      params.push(filters.domain);
    }

    query += ' ORDER BY updated_at DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const result = await this.db.prepare(query).bind(...params).all();

    const projects: ProjectMetadata[] = [];
    for (const row of (result.results || [])) {
      const sessions = await this.getProjectSessions((row as any).project_id);
      
      projects.push({
        projectId: (row as any).project_id,
        createdBy: (row as any).created_by,
        createdAt: (row as any).created_at,
        updatedAt: (row as any).updated_at,
        version: (row as any).version,
        
        title: (row as any).title,
        objective: (row as any).objective,
        domain: (row as any).domain,
        tags: this.parseJson((row as any).tags, []),
        
        status: (row as any).status,
        currentStep: (row as any).current_step,
        totalSteps: (row as any).total_steps,
        
        workflowId: (row as any).workflow_id,
        lastCheckpoint: (row as any).last_checkpoint,
        
        sessions,
      });
    }

    return projects;
  }

  async updateProject(projectId: string, updates: Partial<ProjectMetadata>): Promise<void> {
    await this.ensureInitialized();

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }

    if (updates.currentStep !== undefined) {
      fields.push('current_step = ?');
      values.push(updates.currentStep);
    }

    if (updates.version !== undefined) {
      fields.push('version = ?');
      values.push(updates.version);
    }

    if (updates.lastCheckpoint !== undefined) {
      fields.push('last_checkpoint = ?');
      values.push(updates.lastCheckpoint);
    }

    if (updates.checkpointData !== undefined) {
      fields.push('checkpoint_data = ?');
      values.push(JSON.stringify(updates.checkpointData));
    }

    if (updates.updatedAt !== undefined) {
      fields.push('updated_at = ?');
      values.push(updates.updatedAt);
    }

    if (fields.length === 0) return;

    values.push(projectId);

    await this.db.prepare(`
      UPDATE projects SET ${fields.join(', ')} WHERE project_id = ?
    `).bind(...values).run();
  }

  async searchProjects(query: string, limit = 10): Promise<ProjectMetadata[]> {
    await this.ensureInitialized();

    // Simple LIKE search on title and objective
    const result = await this.db.prepare(`
      SELECT * FROM projects 
      WHERE title LIKE ? OR objective LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).bind(`%${query}%`, `%${query}%`, limit).all();

    const projects: ProjectMetadata[] = [];
    for (const row of (result.results || [])) {
      const sessions = await this.getProjectSessions((row as any).project_id);
      
      projects.push({
        projectId: (row as any).project_id,
        createdBy: (row as any).created_by,
        createdAt: (row as any).created_at,
        updatedAt: (row as any).updated_at,
        version: (row as any).version,
        
        title: (row as any).title,
        objective: (row as any).objective,
        domain: (row as any).domain,
        tags: this.parseJson((row as any).tags, []),
        
        status: (row as any).status,
        currentStep: (row as any).current_step,
        totalSteps: (row as any).total_steps,
        
        workflowId: (row as any).workflow_id,
        
        sessions,
      });
    }

    return projects;
  }

  async recordProjectSession(
    projectId: string,
    sessionId: string,
    action: 'created' | 'resumed' | 'continued' | 'completed' | 'failed'
  ): Promise<void> {
    await this.ensureInitialized();

    await this.db.prepare(`
      INSERT INTO project_sessions (project_id, session_id, action, timestamp)
      VALUES (?, ?, ?, ?)
    `).bind(projectId, sessionId, action, Date.now()).run();
  }

  async getProjectSessions(projectId: string): Promise<ProjectMetadata['sessions']> {
    await this.ensureInitialized();

    const result = await this.db.prepare(`
      SELECT session_id, action, timestamp 
      FROM project_sessions 
      WHERE project_id = ?
      ORDER BY timestamp ASC
    `).bind(projectId).all();

    return (result.results || []).map((row: any) => ({
      sessionId: row.session_id,
      action: row.action,
      timestamp: row.timestamp,
    }));
  }

  // =============================================================
  // Message Operations
  // =============================================================

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (!messages || messages.length === 0) return;
    await this.ensureInitialized();

    const session = await this.getSession(sessionId);
    if (!session) {
      await this.createSession(sessionId);
    }

    for (const msg of messages) {
      const content = JSON.stringify(msg.parts || [{ text: msg.content }]);
      const ts = msg.timestamp || Date.now();
      const metadata = msg.metadata ? JSON.stringify(msg.metadata) : null;

      await this.db.prepare(`
        INSERT INTO messages (session_id, role, content, timestamp, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).bind(sessionId, msg.role, content, ts, metadata).run();
    }

    await this.updateSessionStats(sessionId);
  }

  async loadMessages(sessionId: string, limit = 200): Promise<Message[]> {
    await this.ensureInitialized();

    const result = await this.db.prepare(`
      SELECT role, content, timestamp, metadata
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(sessionId, limit).all();

    if (!result.results) return [];

    return result.results.reverse().map((row: any) => ({
      role: row.role as 'user' | 'model' | 'system',
      parts: this.parseJson(row.content, [{ text: row.content }]),
      timestamp: row.timestamp,
      metadata: row.metadata ? this.parseJson(row.metadata, undefined) : undefined,
    }));
  }

  async getLatestMessageTimestamp(sessionId: string): Promise<number> {
    const stats = await this.getSessionStats(sessionId);
    return stats.latest;
  }

  private async getSessionStats(sessionId: string): Promise<{ count: number; latest: number }> {
    await this.ensureInitialized();

    const row = await this.db.prepare(`
      SELECT COUNT(*) as count, MAX(timestamp) as latest
      FROM messages WHERE session_id = ?
    `).bind(sessionId).first<{ count: number; latest: number }>();

    return {
      count: row?.count || 0,
      latest: row?.latest || 0,
    };
  }

  private async updateSessionStats(sessionId: string): Promise<void> {
    const stats = await this.getSessionStats(sessionId);
    await this.db.prepare(`
      UPDATE sessions 
      SET message_count = ?, last_activity_at = ? 
      WHERE session_id = ?
    `).bind(stats.count, Date.now(), sessionId).run();
  }

  // =============================================================
  // Utilities
  // =============================================================

  private parseJson<T>(str: string | null | undefined, defaultValue: T): T {
    if (!str) return defaultValue;
    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.db.prepare('SELECT 1').first();
      return true;
    } catch {
      return false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export default D1Manager;
