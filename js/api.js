// Typed-ish wrappers over every server RPC the client uses. This file is the
// contract: parameter names here MUST match the SQL function signatures exactly
// (PostgREST resolves overloads by argument name). If a call fails with
// "Could not find the function ... in the schema cache", the arg names are wrong.
import { sb } from './sb.js';

export class ApiError extends Error {
  constructor(fn, error) {
    super(error?.message || 'request failed');
    this.name = 'ApiError';
    this.fn = fn;
    this.code = error?.code;
    this.details = error?.details;
  }
}

// Throws on error. Use for writes where failure must surface.
export async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new ApiError(fn, error);
  return data;
}

// Never throws: returns [data, error]. Use for optional/background reads.
export async function tryRpc(fn, args) {
  try { return [await rpc(fn, args), null]; } catch (e) { return [null, e]; }
}

// Read a table directly (RLS-protected). Returns [] on error rather than throwing.
export async function table(name, build) {
  let q = sb.from(name).select('*');
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) { console.warn('table', name, error.message); return []; }
  return data || [];
}

export const api = {
  // ---------- identity + profile ----------
  setProfile: (p) => rpc('set_profile', {
    p_display_name: p.display_name ?? null, p_avatar_key: p.avatar_key ?? null,
    p_pronouns: p.pronouns ?? null, p_status_text: p.status_text ?? null,
    p_status_emoji: p.status_emoji ?? null, p_timezone: p.timezone ?? 'Asia/Kolkata',
  }),
  // The optional channel is the viewer census that feeds channels.viewer_count
  // and therefore the digest safety valve (0057). It rides on the liveness beat
  // so it costs no extra request. Null means "I am not looking at a channel".
  heartbeat: (status = 'online', channel = null) =>
    rpc('heartbeat', { p_status: status, p_channel: channel }),
  setStatus: (text, emoji, expiresAt = null) =>
    rpc('set_status', { p_text: text, p_emoji: emoji, p_expires_at: expiresAt }),
  clearStatus: () => rpc('clear_status', {}),
  setPresenceStatus: (s) => rpc('set_presence_status', { p_status: s }),
  effectiveStatus: (user) => rpc('get_effective_status', { p_user: user }),
  profileCard: (user) => rpc('get_profile_card', { p_user: user }),
  exportMyData: () => rpc('export_my_data', {}),
  completePasswordSetup: () => rpc('complete_password_setup', {}),
  mustSetPassword: () => rpc('must_set_password', {}),
  anonymizeAccount: () => rpc('anonymize_account', {}),

  // ---------- spaces / workspaces ----------
  createSpace: (name) => rpc('create_space', { p_name: name }),
  createWorkspace: (org, slug, name) => rpc('create_workspace', { p_org: org, p_slug: slug, p_name: name }),
  bootstrap: (ws) => rpc('get_bootstrap', { p_workspace: ws }),
  spaceSummary: () => rpc('get_space_summary', {}),
  leaveWorkspace: (ws) => rpc('leave_workspace', { p_workspace: ws }),
  setWorkspaceGate: (ws, level, requiresApproval, rules) => rpc('set_workspace_gate', {
    p_workspace: ws, p_verification_level: level,
    p_requires_approval: requiresApproval, p_rules_text: rules,
  }),
  acceptRules: (ws) => rpc('accept_rules', { p_workspace: ws }),
  requestJoin: (ws) => rpc('request_join', { p_workspace: ws }),
  approveJoin: (req) => rpc('approve_join_request', { p_request: req }),
  rejectJoin: (req) => rpc('reject_join_request', { p_request: req }),

  // ---------- invites ----------
  createInvite: (ws, maxUses = null, expiresAt = null, grantRole = null) =>
    rpc('create_invite', {
      p_workspace: ws, p_max_uses: maxUses, p_expires_at: expiresAt, p_grant_role: grantRole,
    }),
  redeemInvite: (token) => rpc('redeem_invite', { p_token: token }),
  listInvites: (ws) => rpc('list_invites', { p_workspace: ws }),
  revokeInvite: (id) => rpc('revoke_invite', { p_id: id }),

  // ---------- channels + categories ----------
  createChannel: (ws, name, kind = 'text', category = null, isPrivate = false) =>
    rpc('create_channel', {
      p_workspace: ws, p_name: name, p_kind: kind, p_category: category, p_is_private: isPrivate,
    }),
  updateChannel: (ch, patch = {}) => rpc('update_channel', {
    p_channel: ch, p_name: patch.name ?? null, p_topic: patch.topic ?? null,
    p_category: patch.category ?? null, p_position: patch.position ?? null,
  }),
  deleteChannel: (ch) => rpc('delete_channel', { p_channel: ch }),
  archiveChannel: (ch, bool) => rpc('archive_channel', { p_channel: ch, p_bool: bool }),
  addChannelMember: (ch, user) => rpc('add_channel_member', { p_channel: ch, p_user: user }),
  createCategory: (ws, name) => rpc('create_category', { p_workspace: ws, p_name: name }),
  updateCategory: (cat, patch = {}) =>
    rpc('update_category', { p_category: cat, p_name: patch.name ?? null, p_position: patch.position ?? null }),
  deleteCategory: (cat) => rpc('delete_category', { p_category: cat }),
  setSlowmode: (ch, seconds) => rpc('set_slowmode', { p_channel: ch, p_seconds: seconds }),
  setReadonly: (ch, bool) => rpc('set_readonly', { p_channel: ch, p_bool: bool }),
  followChannel: (ch) => rpc('follow_channel', { p_channel: ch }),
  unfollowChannel: (ch) => rpc('unfollow_channel', { p_channel: ch }),

  // ---------- messages ----------
  channelMessages: (ch, beforeSeq = null, limit = 50) =>
    rpc('get_channel_messages', { p_channel: ch, p_before_seq: beforeSeq, p_limit: limit }),
  messagesAround: (ch, seq, before = 25, after = 25) =>
    rpc('get_messages_around', { p_channel: ch, p_seq: seq, p_before: before, p_after: after }),
  send: (o) => rpc('send_message', {
    p_channel: o.channel, p_client_msg_id: o.nonce, p_body: o.body ?? { text: o.text || '' },
    p_body_text: o.text || '', p_attachments: o.attachments ?? [],
    p_mentions: o.mentions ?? [], p_mention_scope: o.mentionScope ?? 'none',
    p_reply_to: o.replyTo ?? null, p_thread: o.thread ?? null,
    ...(o.alsoSend === undefined ? {} : { p_also_send: !!o.alsoSend }),
  }),
  edit: (id, text) => rpc('edit_message', { p_message: id, p_body: { text }, p_body_text: text }),
  del: (id) => rpc('delete_message', { p_message: id }),
  forward: (id, toChannel, nonce) =>
    rpc('forward_message', { p_message: id, p_to_channel: toChannel, p_client_msg_id: nonce }),
  permalink: (id) => rpc('get_permalink', { p_message: id }),
  pin: (id) => rpc('pin_message', { p_message: id }),
  unpin: (id) => rpc('unpin_message', { p_message: id }),
  saveItem: (id) => rpc('save_item', { p_message: id }),
  unsaveItem: (id) => rpc('unsave_item', { p_message: id }),
  listSaved: () => rpc('list_saved', {}),
  react: (id, emoji) => rpc('toggle_reaction', { p_message: id, p_emoji: emoji }),
  markRead: (scopeType, scopeId, upToSeq) =>
    rpc('mark_read', { p_scope_type: scopeType, p_scope_id: scopeId, p_up_to_seq: upToSeq }),
  markUnread: (scopeType, scopeId, fromSeq) =>
    rpc('mark_unread', { p_scope_type: scopeType, p_scope_id: scopeId, p_from_seq: fromSeq }),
  unread: (ws) => rpc('get_unread', { p_workspace: ws }),
  sync: (cursors) => rpc('sync', { p_cursors: cursors }),
  // RESUME: one channel, everything past `seq`, plus the retention floor and
  // whether more was withheld. sync() above cannot express either.
  resume: (ch, seq, limit = 200) =>
    rpc('resume', { p_channel: ch, p_seq: seq, p_limit: limit }),
  resumeDM: (conv, seq, limit = 200) =>
    rpc('resume_dm', { p_conversation: conv, p_seq: seq, p_limit: limit }),
  schedule: (ch, text, deliverAt, mentions = []) =>
    rpc('schedule_message', { p_channel: ch, p_body_text: text, p_deliver_at: deliverAt, p_mentions: mentions }),
  listScheduled: (ws) => rpc('list_scheduled', { p_workspace: ws }),
  cancelScheduled: (id) => rpc('cancel_scheduled', { p_id: id }),
  setPriority: (id, priority) => rpc('set_priority', { p_message: id, p_priority: priority }),
  ack: (id) => rpc('ack_message', { p_message: id }),
  acks: (id) => rpc('get_acks', { p_message: id }),
  reportMessage: (id, reason) => rpc('report_message', { p_message: id, p_reason: reason }),
  resolveReport: (id, status) => rpc('resolve_report', { p_report: id, p_status: status }),

  // ---------- threads ----------
  createThread: (rootMessage, title = null) =>
    rpc('create_thread', { p_root_message: rootMessage, p_title: title }),
  threadMessages: (thread) => rpc('get_thread_messages', { p_thread: thread }),
  elevateThread: (thread, title = null) => rpc('elevate_thread', { p_thread: thread, p_title: title }),
  promoteThread: (thread, channelName) =>
    rpc('promote_thread_to_channel', { p_thread: thread, p_channel_name: channelName }),
  listThreads: (ws, limit = 50) => rpc('list_threads', { p_workspace: ws, p_limit: limit }),
  followThread: (thread) => rpc('follow_thread', { p_thread: thread }),
  unfollowThread: (thread) => rpc('unfollow_thread', { p_thread: thread }),
  markThreadRead: (thread, upToSeq) =>
    rpc('mark_thread_read', { p_thread: thread, p_up_to_seq: upToSeq }),

  // ---------- topics (Zulip-style) ----------
  listTopics: (ch) => rpc('list_topics', { p_channel: ch }),
  topicMessages: (ch, topic, limit = 50) =>
    rpc('get_topic_messages', { p_channel: ch, p_topic: topic, p_limit: limit }),
  setMessageTopic: (id, topic) => rpc('set_message_topic', { p_message: id, p_topic: topic }),
  markTopicRead: (ch, topic, upToSeq) =>
    rpc('mark_topic_read', { p_channel: ch, p_topic: topic, p_up_to_seq: upToSeq }),
  moveTopic: (ch, from, to) => rpc('move_topic', { p_channel: ch, p_from_topic: from, p_to_topic: to }),

  // ---------- DMs ----------
  createDM: (ws, users) => rpc('create_dm', { p_workspace: ws, p_users: users }),
  sendDM: (o) => rpc('send_dm', {
    p_conversation: o.conversation, p_client_msg_id: o.nonce,
    p_body: o.body ?? { text: o.text || '' }, p_body_text: o.text || '',
    p_attachments: o.attachments ?? [], p_reply_to: o.replyTo ?? null,
  }),
  markDMRead: (conv, upToSeq) => rpc('mark_dm_read', { p_conversation: conv, p_up_to_seq: upToSeq }),
  dmReceipts: (conv) => rpc('get_dm_receipts', { p_conversation: conv }),
  dmUnread: (ws) => rpc('get_dm_unread', { p_workspace: ws }),

  // ---------- search ----------
  search: (o) => rpc('search_messages', {
    p_query: o.query, p_workspace: o.workspace, p_channel: o.channel ?? null,
    p_from_user: o.fromUser ?? null, p_has: o.has ?? null,
    p_before: o.before ?? null, p_after: o.after ?? null, p_limit: o.limit ?? 40,
  }),

  // ---------- notifications ----------
  activity: (ws, limit = 40) => rpc('get_activity', { p_workspace: ws, p_limit: limit }),
  notifySettings: (ws) => rpc('get_notify_settings', { p_workspace: ws }),
  setNotifyLevel: (scopeType, scopeId, level, mutedUntil = null) => rpc('set_notify_level', {
    p_scope_type: scopeType, p_scope_id: scopeId, p_level: level, p_muted_until: mutedUntil,
  }),
  setDnd: (until) => rpc('set_dnd', { p_until: until }),
  setQuietHours: (start, end) => rpc('set_quiet_hours', { p_start: start, p_end: end }),
  pushSubscribe: (endpoint, p256dh, auth, ua) =>
    rpc('upsert_push_subscription', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_ua: ua }),

  // ---------- later queue + reminders ----------
  laterAdd: (id) => rpc('later_add', { p_message: id }),
  laterRemove: (id) => rpc('later_remove', { p_message: id }),
  laterSetState: (id, state) => rpc('later_set_state', { p_message: id, p_state: state }),
  later: () => rpc('get_later', {}),
  remindMe: (id, at, note = null) => rpc('remind_me', { p_message: id, p_remind_at: at, p_note: note }),
  cancelReminder: (id) => rpc('cancel_reminder', { p_id: id }),

  // ---------- drafts ----------
  saveDraft: (scopeType, scopeId, text) =>
    rpc('save_draft', { p_scope_type: scopeType, p_scope_id: scopeId, p_body_text: text }),
  deleteDraft: (scopeType, scopeId) =>
    rpc('delete_draft', { p_scope_type: scopeType, p_scope_id: scopeId }),
  drafts: () => rpc('get_drafts', {}),

  // ---------- polls ----------
  createPoll: (ch, question, options, multi = false, closesAt = null) => rpc('create_poll', {
    p_channel: ch, p_question: question, p_options: options, p_multi: multi, p_closes_at: closesAt,
  }),
  getPoll: (poll) => rpc('get_poll', { p_poll: poll }),
  vote: (poll, optionIds) => rpc('vote', { p_poll: poll, p_option_ids: optionIds }),
  closePoll: (poll) => rpc('close_poll', { p_poll: poll }),

  // ---------- events ----------
  createEvent: (o) => rpc('create_event', {
    p_workspace: o.workspace, p_title: o.title, p_desc: o.desc ?? null,
    p_starts_at: o.startsAt, p_ends_at: o.endsAt ?? null,
    p_location: o.location ?? null, p_channel: o.channel ?? null,
  }),
  listEvents: (ws, upcomingOnly = true) =>
    rpc('list_events', { p_workspace: ws, p_upcoming_only: upcomingOnly }),
  getEvent: (id) => rpc('get_event', { p_event: id }),
  rsvp: (id, status) => rpc('rsvp_event', { p_event: id, p_status: status }),
  cancelEvent: (id) => rpc('cancel_event', { p_event: id }),

  // ---------- canvases ----------
  createCanvas: (ws, title, channel = null) =>
    rpc('create_canvas', { p_workspace: ws, p_title: title, p_channel: channel }),
  listCanvases: (ws) => rpc('list_canvases', { p_workspace: ws }),
  getCanvas: (id) => rpc('get_canvas', { p_canvas: id }),
  updateCanvasTitle: (id, title) => rpc('update_canvas_title', { p_canvas: id, p_title: title }),
  addBlock: (canvas, type, content, position) =>
    rpc('add_block', { p_canvas: canvas, p_type: type, p_content: content, p_position: position }),
  updateBlock: (block, content, checked = null, position = null) =>
    rpc('update_block', { p_block: block, p_content: content, p_checked: checked, p_position: position }),
  deleteBlock: (block) => rpc('delete_block', { p_block: block }),

  // ---------- forum ----------
  createForumPost: (ch, title, body, tagIds = []) =>
    rpc('create_forum_post', { p_channel: ch, p_title: title, p_body_text: body, p_tag_ids: tagIds }),
  listForumPosts: (ch, tag = null) => rpc('list_forum_posts', { p_channel: ch, p_tag: tag }),
  createForumTag: (ch, name) => rpc('create_forum_tag', { p_channel: ch, p_name: name }),

  // ---------- bookmarks + snippets ----------
  listBookmarks: (ch) => rpc('list_bookmarks', { p_channel: ch }),
  addBookmark: (ch, label, url, position = 0) =>
    rpc('add_bookmark', { p_channel: ch, p_label: label, p_url: url, p_position: position }),
  removeBookmark: (id) => rpc('remove_bookmark', { p_bookmark: id }),
  createSnippet: (ws, title, language, code) =>
    rpc('create_snippet', { p_workspace: ws, p_title: title, p_language: language, p_code: code }),
  listSnippets: () => rpc('list_my_snippets', {}),
  getSnippet: (id) => rpc('get_snippet', { p_snippet: id }),

  // ---------- roles + members ----------
  listRoles: (ws) => rpc('list_roles', { p_workspace: ws }),
  createRole: (ws, name, permissions = 0, color = 0) =>
    rpc('create_role', { p_workspace: ws, p_name: name, p_permissions: permissions, p_color: color }),
  updateRole: (role, patch = {}) => rpc('update_role', {
    p_role: role, p_name: patch.name ?? null, p_permissions: patch.permissions ?? null,
    p_color: patch.color ?? null, p_position: patch.position ?? null,
  }),
  deleteRole: (role) => rpc('delete_role', { p_role: role }),
  assignRole: (ws, user, role) => rpc('assign_role', { p_workspace: ws, p_user: user, p_role: role }),
  selfAssignRole: (ws, role) => rpc('self_assign_role', { p_workspace: ws, p_role: role }),
  selfUnassignRole: (ws, role) => rpc('self_unassign_role', { p_workspace: ws, p_role: role }),
  addSelfRole: (ws, role) => rpc('add_self_role', { p_workspace: ws, p_role: role }),
  removeSelfRole: (ws, role) => rpc('remove_self_role', { p_workspace: ws, p_role: role }),
  setReactionRole: (msg, emoji, role) =>
    rpc('set_reaction_role', { p_message: msg, p_emoji: emoji, p_role: role }),
  removeReactionRole: (msg, emoji) => rpc('remove_reaction_role', { p_message: msg, p_emoji: emoji }),
  applyReactionRole: (msg, emoji) => rpc('apply_reaction_role', { p_message: msg, p_emoji: emoji }),
  createUserGroup: (ws, handle, name) =>
    rpc('create_user_group', { p_workspace: ws, p_handle: handle, p_name: name }),
  setUserGroupMembers: (group, users) =>
    rpc('set_user_group_members', { p_group: group, p_users: users }),
  resolveGroupMentions: (ws, handles) =>
    rpc('resolve_group_mentions', { p_workspace: ws, p_handles: handles }),

  // ---------- moderation ----------
  kick: (ws, user) => rpc('kick_member', { p_workspace: ws, p_user: user }),
  ban: (ws, user, reason = null) => rpc('ban_member', { p_workspace: ws, p_user: user, p_reason: reason }),
  unban: (ws, user) => rpc('unban_member', { p_workspace: ws, p_user: user }),
  timeout: (ws, user, until) => rpc('timeout_member', { p_workspace: ws, p_user: user, p_until: until }),
  blockUser: (user) => rpc('block_user', { p_user: user }),
  unblockUser: (user) => rpc('unblock_user', { p_user: user }),
  addAutomod: (ws, pattern, kind) =>
    rpc('add_automod_rule', { p_workspace: ws, p_pattern: pattern, p_kind: kind }),
  removeAutomod: (id) => rpc('remove_automod_rule', { p_id: id }),

  // ---------- admin console ----------
  adminMembers: (ws) => rpc('admin_list_members', { p_workspace: ws }),
  adminChannels: (ws) => rpc('admin_list_channels', { p_workspace: ws }),
  adminStats: (ws) => rpc('admin_stats', { p_workspace: ws }),
  adminAudit: (ws, limit = 50) => rpc('admin_recent_audit', { p_workspace: ws, p_limit: limit }),

  // ---------- integrations ----------
  createWebhook: (ch, name) => rpc('create_webhook', { p_channel: ch, p_name: name }),
  revokeWebhook: (id) => rpc('revoke_webhook', { p_id: id }),
  createBot: (ws, name) => rpc('create_bot', { p_workspace: ws, p_name: name }),
  getBot: (id) => rpc('get_bot', { p_id: id }),
  revokeBot: (id) => rpc('revoke_bot', { p_id: id }),
  listSlashCommands: (ws) => rpc('list_slash_commands', { p_workspace: ws }),
  registerSlashCommand: (ws, command, description, handlerUrl) => rpc('register_slash_command', {
    p_workspace: ws, p_command: command, p_description: description, p_handler_url: handlerUrl,
  }),
  listCustomEmoji: (ws) => rpc('list_custom_emoji', { p_workspace: ws }),
  createCustomEmoji: (ws, name, imageKey) =>
    rpc('create_custom_emoji', { p_workspace: ws, p_name: name, p_image_key: imageKey }),

  // ---------- voice ----------
  joinVoice: (ch) => rpc('join_voice', { p_channel: ch }),
  leaveVoice: (ch) => rpc('leave_voice', { p_channel: ch }),
  voiceHeartbeat: (ch) => rpc('voice_heartbeat', { p_channel: ch }),
  canJoinVoice: (ch) => rpc('can_join_voice', { p_channel: ch }),

  // ---------- attachments ----------
  finalizeAttachment: (o) => rpc('finalize_attachment', {
    p_object_key: o.objectKey, p_sha256: o.sha256, p_mime: o.mime, p_byte_size: o.byteSize,
    p_width: o.width ?? null, p_height: o.height ?? null,
    p_duration_ms: o.durationMs ?? null, p_thumbhash: o.thumbhash ?? null,
  }),
};

export default api;
