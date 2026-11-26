'use strict';
// Explicit, bounded internal actions. No LLM, external messages, device controls,
// purchases or compliance submissions are executed by this module.
const { randomUUID, createHash } = require('node:crypto');
const { HttpError, dateKey } = require('./access');
const DAY = 86400000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid workflow details');
}
function text(value, max, label, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/).test(value)) throw new HttpError(400, `Enter valid ${label}`);
  return value.trim();
}
function schedule(payload, now) {
  const date = payload.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date || date < dateKey(now) || Date.parse(`${date}T12:00:00Z`) > now + 731 * DAY) throw new HttpError(400, 'Choose a real date from today through the next two years');
  const time = payload.time === undefined ? '' : payload.time;
  if (typeof time !== 'string' || time !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Choose a valid Pacific time or leave it blank');
  return { date, time };
}
function fieldFor(state, id) {
  if (!id) return null;
  if (typeof id !== 'string' || id.length > 100) throw new HttpError(400, 'Choose a saved field');
  const field = state.fields?.find(item => item.id === id);
  if (!field) throw new HttpError(409, 'The selected field no longer exists. Reload and review a new proposal.');
  return field;
}
function taskFor(state, id) {
  if (!['string', 'number'].includes(typeof id)) throw new HttpError(400, 'Choose an existing task');
  const task = state.tasks?.find(item => String(item.id) === String(id));
  if (!task || task.done) throw new HttpError(409, 'This task is missing or already completed. Reload and review a new proposal.');
  return task;
}
function applyWorkflow({ operations, state, action, payload, now = Date.now() }) {
  if (!Number.isFinite(now)) throw new HttpError(400, 'Invalid operation time');
  if (!state?.profile) throw new HttpError(409, 'Save a farm profile before preparing work');
  const next = structuredClone(operations), farm = structuredClone(state), timestamp = new Date(now).toISOString();
  next.workflows ||= [];
  if (action === 'proposeWorkflow') {
    object(payload, ['kind', 'fieldId', 'taskId', 'title', 'text', 'date', 'time', 'recipient']);
    if (!['create_task', 'reschedule_task', 'prepare_record', 'draft_message'].includes(payload.kind)) throw new HttpError(400, 'Choose a supported internal workflow');
    if (next.workflows.filter(item => item.status === 'pending' && Date.parse(item.expiresAt) > now).length >= 20) throw new HttpError(409, 'Review or cancel pending proposals before preparing more');
    const preview = { kind: payload.kind }, expected = {};
    let field = fieldFor(farm, payload.fieldId), title;
    if (payload.kind === 'create_task') {
      title = text(payload.title, 200, 'task title');
      Object.assign(preview, { title }, schedule(payload, now));
      if ((farm.tasks || []).length >= 300) throw new HttpError(409, 'The farm has reached its 300-task limit');
    } else if (payload.kind === 'reschedule_task') {
      const task = taskFor(farm, payload.taskId);
      field = fieldFor(farm, task.fieldId);
      title = `Reschedule: ${task.name}`.slice(0, 200);
      Object.assign(preview, { taskId: task.id, title, existingTask: { name: task.name, date: task.date || '', time: task.time || '' } }, schedule(payload, now));
      expected.task = hash(task);
    } else {
      title = text(payload.title, 200, payload.kind === 'draft_message' ? 'message subject' : 'record title');
      Object.assign(preview, { title, text: text(payload.text, 8000, 'record or message text', true) });
      if (payload.kind === 'draft_message') {
        const recipient = text(payload.recipient, 254, 'recipient email');
        if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) throw new HttpError(400, 'Enter one recipient email address');
        preview.recipient = recipient;
      }
    }
    if (field) { preview.fieldId = field.id; preview.fieldName = field.name; expected.field = hash(field); }
    const workflow = { id: `workflow-${randomUUID()}`, kind: payload.kind, title, status: 'pending', createdAt: timestamp, expiresAt: new Date(now + DAY).toISOString(), preview, expected };
    // Results may be the only copy of a farmer's record or message draft. Never
    // silently evict saved work to make room for an unrelated new proposal.
    if (next.workflows.length >= 100) throw new HttpError(409, 'Workflow history is full. Export your records, then remove a completed or cancelled workflow before preparing more.');
    next.workflows.push(workflow);
    return { operations: next, state: farm, result: { id: workflow.id, message: 'Proposal saved. Review the exact details before approving; nothing has run.' } };
  }
  if (!['executeWorkflow', 'cancelWorkflow', 'deleteWorkflow'].includes(action)) throw new HttpError(400, 'Unsupported workflow action');
  object(payload, ['id']);
  const id = text(payload.id, 100, 'workflow ID'), workflow = next.workflows.find(item => item.id === id);
  if (!workflow) throw new HttpError(404, 'Workflow not found');
  if (action === 'deleteWorkflow') {
    if (!['executed', 'cancelled'].includes(workflow.status)) throw new HttpError(409, 'Cancel a pending proposal before removing its saved record.');
    next.workflows = next.workflows.filter(item => item.id !== id);
    return { operations: next, state: farm, result: { id, message: 'Saved workflow record removed. Previously created or rescheduled tasks remain unchanged.' } };
  }
  if (action === 'cancelWorkflow') {
    if (workflow.status === 'executed') throw new HttpError(409, 'This workflow already ran. Cancel does not undo saved work.');
    workflow.status = 'cancelled'; workflow.cancelledAt ||= timestamp;
    return { operations: next, state: farm, result: { id, message: 'Proposal cancelled. No work was executed.' } };
  }
  if (workflow.status === 'executed') return { operations: next, state: farm, result: { ...workflow.result, id, alreadyExecuted: true } };
  if (workflow.status !== 'pending') throw new HttpError(409, 'Only a pending proposal can run');
  if (!Number.isFinite(Date.parse(workflow.expiresAt)) || Date.parse(workflow.expiresAt) <= now || Date.parse(workflow.createdAt) > now) throw new HttpError(409, 'This proposal expired. Prepare and review a new one.');
  const preview = workflow.preview;
  const field = fieldFor(farm, preview.fieldId);
  if (workflow.expected?.field && (!field || hash(field) !== workflow.expected.field)) throw new HttpError(409, 'This field changed after the proposal. Prepare and review a new one.');
  let result;
  if (workflow.kind === 'create_task') {
    schedule(preview, now);
    farm.tasks ||= [];
    if (farm.tasks.length >= 300) throw new HttpError(409, 'The farm has reached its 300-task limit');
    const task = { id: `task-${randomUUID()}`, name: preview.title, place: field?.name || '', date: preview.date, time: preview.time, status: preview.time ? 'Scheduled' : 'Choose time', done: false, createdAt: timestamp, jobId: id, ...(field ? { fieldId: field.id } : {}) };
    farm.tasks.push(task);
    result = { id, taskId: task.id, task: structuredClone(task), message: 'Task created in your farm task list. No field work or equipment action was performed.' };
  } else if (workflow.kind === 'reschedule_task') {
    schedule(preview, now);
    const task = taskFor(farm, preview.taskId);
    if (hash(task) !== workflow.expected?.task) throw new HttpError(409, 'This task changed after the proposal. Prepare and review a new one.');
    Object.assign(task, { date: preview.date, time: preview.time, status: preview.time ? 'Scheduled' : 'Choose time' });
    result = { id, taskId: task.id, task: structuredClone(task), message: 'Task rescheduled in Farmer Daily. External calendars were not changed.' };
  } else if (workflow.kind === 'prepare_record') {
    result = { id, record: { title: preview.title, text: preview.text, ...(field ? { fieldId: field.id, fieldName: field.name } : {}), recordedAt: timestamp }, message: 'Private farm record prepared and saved. This is not a certified compliance record or a submitted report.' };
  } else if (workflow.kind === 'draft_message') {
    result = { id, draft: { recipient: preview.recipient, title: preview.title, text: preview.text }, message: 'Message draft prepared and saved. Nothing was sent; copy or download it for your own review.' };
  } else throw new HttpError(409, 'This workflow type is not supported');
  workflow.status = 'executed'; workflow.executedAt = timestamp; workflow.result = result;
  return { operations: next, state: farm, result };
}
module.exports = { applyWorkflow };
