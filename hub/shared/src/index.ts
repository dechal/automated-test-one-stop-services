/**
 * @hub/shared — DTOs and types shared between Hub server and client.
 *
 * Keep this package framework-free. Server (Fastify) and client (React)
 * both import from here, so no Node-specific or DOM-specific code.
 *
 * Public surface is unchanged — every consumer keeps importing from
 * `@hub/shared`. Domain split exists purely for maintainability: one file
 * per concern instead of one ~600-line monolith.
 */

export * from './domains/api.js';
export * from './domains/compare.js';
export * from './domains/dashboard.js';
export * from './domains/doctor.js';
export * from './domains/env.js';
export * from './domains/flaky.js';
export * from './domains/import-export.js';
export * from './domains/projects.js';
export * from './domains/reports.js';
export * from './domains/run-summary.js';
export * from './domains/runs.js';
export * from './domains/schedules.js';
export * from './domains/severity-score.js';
export * from './domains/tags.js';
export * from './domains/task-exit-code.js';
export * from './domains/testcases.js';
export * from './domains/tool-plugins.js';
export * from './domains/tools.js';
export * from './domains/webhooks.js';
