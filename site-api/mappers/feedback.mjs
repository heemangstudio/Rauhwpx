import { checkRoot, defineTable, storeMisfit } from '../pg-store.mjs';

/**
 * feedback/index.json `{ reports: [summary, ...] }` ↔ feedback_reports (migrations/002), one row per
 * report in array order. report.json and the attachments stay files in feedback/<id>/ in both modes.
 */

const REPORTS = defineTable('feedback_reports', {
  key: ['id'],
  fields: {
    id: ['text', 'id', { required: true }],
    received_at: ['time', 'receivedAt'],
    created_at: ['time', 'createdAt'],
    status: ['text', 'status'],
    install_hash: ['text', 'installHash'],
    email: ['text', 'email'],
    preview: ['text', 'preview'],
    app_version: ['text', 'appVersion'],
    os: ['text', 'os'],
    os_version: ['text', 'osVersion'],
    arch: ['text', 'arch'],
    attachments: ['object', 'attachments'],
    bytes: ['int', 'bytes'],
  },
});

export const feedbackMapper = Object.freeze({
  domain: 'feedback',
  tables: [REPORTS],
  toRows(state) {
    checkRoot('feedback', state, ['reports']);
    if (!Array.isArray(state.reports)) throw storeMisfit('feedback.reports is not an array');
    return { feedback_reports: Array.from(state.reports, (report) => REPORTS.pack(report)) };
  },
  fromRows(rows) {
    return { reports: rows.feedback_reports.map((row) => REPORTS.unpack(row)) };
  },
});
