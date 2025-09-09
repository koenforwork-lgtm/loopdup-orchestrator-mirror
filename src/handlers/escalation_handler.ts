// packages/orchestrator/src/handlers/escalation_handler.ts
import {
  addLabel,
  addPrivateMessage,
  assignToUser,
  getConversation,
  updateConversationStatus,
  updateConversationPriority,
  ChatwootPriority,
  ChatwootStatus,             // ← imported to enforce only 'open' | 'resolved'
  ensureLabel,
  addLabels,
} from '../adapters/chatwoot_adapter';
import {
  enterSoftWatch,
  enterHardPause,
  markEscalatedOnce,
  clearPause,
  clearState,
  getState,
  resetNegativeCount,
  manualPauseForMinutes,
} from '../repos/conv_state_repo';

const NEEDS_STAFF_LABEL = 'needs_staff';
const ISSUE_LABEL = 'issue_report';

const DEFAULT_ASSIGN =
  (Number(process.env.CW_DEFAULT_ASSIGNEE_ID || 0) || undefined) as number | undefined;
const DEFAULT_TEAM =
  (Number(process.env.CW_TEAM_ID || 0) || undefined) as number | undefined;
const SOFTWATCH_NOTIFY_ONCE =
  String(process.env.SOFTWATCH_NOTIFY_ONCE ?? 'true').toLowerCase() === 'true';

const EMERGENCY_WORDS = ['fire', 'medical', 'ambulance', 'flood', 'theft', 'police', 'help now'];
type IntentKind = 'FAQ' | 'SERVICE' | 'CHITCHAT' | 'UNKNOWN';

function priorityFromSignal(
  intent: IntentKind,
  negativeCount: number,
  text: string,
  isNegative = false
): ChatwootPriority {
  const t = (text || '').toLowerCase();
  if (EMERGENCY_WORDS.some(w => t.includes(w))) return 'urgent';
  if (isNegative) return 'high';
  if (negativeCount >= 2) return 'high';
  if (intent === 'SERVICE') return 'medium';
  return 'low';
}

type SoftEscalationOpts = {
  assignTo?: number;
  notifyOnce?: boolean;
  label?: string;
  intent?: IntentKind;
  negativeCount?: number;
  text?: string;
  issue?: boolean;
};

export async function handleSoftEscalation(event: any, opts?: SoftEscalationOpts) {
  const { conversationId, propertyId } = event;
  console.log('[escalation.soft] start', { conversationId, opts });

  try {
    const labelsToAdd = [NEEDS_STAFF_LABEL];
    if (opts?.label && opts.label !== NEEDS_STAFF_LABEL) labelsToAdd.push(opts.label);
    if (opts?.issue) labelsToAdd.push(ISSUE_LABEL);
    await addLabels(conversationId, labelsToAdd);
  } catch (e) {
    console.error('[soft-escalation] add labels failed', { conversationId, e });
  }

  try {
    const prio = priorityFromSignal(
      (opts?.intent as IntentKind) ?? 'UNKNOWN',
      opts?.negativeCount ?? 0,
      opts?.text ?? '',
      opts?.issue === true
    );
    await updateConversationPriority(conversationId, prio);

    // 🚫 Only use 'open' or 'resolved'; never pending/snoozed
    await updateConversationStatus(conversationId, 'open');
  } catch (e) {
    console.error('[soft-escalation] status/priority failed', { conversationId, e });
  }

  const alreadyEsc = await markEscalatedOnce(propertyId, conversationId);
  if (!alreadyEsc) {
    const shouldNotify =
      typeof opts?.notifyOnce === 'boolean' ? !!opts?.notifyOnce : SOFTWATCH_NOTIFY_ONCE;
    if (shouldNotify) {
      try {
        await addPrivateMessage(conversationId, '👀 Bot escalated');
      } catch (e) {
        console.error('[soft-escalation] private ping failed', { conversationId, e });
      }
    }
  }

  await enterSoftWatch(propertyId, conversationId);

  const assignee = typeof opts?.assignTo === 'number' ? opts.assignTo : DEFAULT_ASSIGN;
  if (assignee) {
    try {
      const convo = (await getConversation(conversationId)) as any;
      const assigned = Number(convo?.assignee_id || 0) > 0;
      if (!assigned) {
        await assignToUser(conversationId, assignee, DEFAULT_TEAM);
        console.log('[soft-escalation] auto-assigned to', assignee);
      }
    } catch (e) {
      console.error('[soft-escalation] assign check/assign failed', { conversationId, assignee, e });
    }
  }

  return { escalated: true, mode: 'soft_watch' };
}

export async function handleHardPause(event: any, minutes = 30) {
  const { conversationId, propertyId } = event;
  console.log('[escalation.hard] start', { conversationId, minutes });

  try {
    // 🚫 Force to 'open'; never snooze
    await updateConversationStatus(conversationId, 'open');
  } catch (e) {
    console.error('[hard-pause] set status failed', { conversationId, e });
  }

  let alreadyPaused = false;
  try {
    const s = (await getState(propertyId, conversationId)) as any;
    const resumeOk   = !!s?.resume_at    && new Date(s.resume_at).getTime()    > Date.now();
    const untilOk    = !!s?.paused_until && new Date(s.paused_until).getTime() > Date.now();
    const boolPaused = !!s?.paused;
    alreadyPaused = resumeOk || untilOk || boolPaused;
  } catch {}

  if (!alreadyPaused) {
    try {
      await addPrivateMessage(conversationId, '⏸️ Bot paused');
    } catch (e) {
      console.error('[hard-pause] private note failed', { conversationId, e });
    }
  } else {
    console.log('[hard-pause] already paused; skip duplicate note');
  }

  await manualPauseForMinutes(propertyId, conversationId, minutes);

  return { escalated: true, mode: 'hard_pause' };
}

export async function resumeBot(event: any) {
  const { conversationId, propertyId } = event;
  console.log('[escalation.resume] start', { conversationId });

  let wasPaused = false;
  try {
    const s = (await getState(propertyId, conversationId)) as any;
    const resumeOk   = !!s?.resume_at    && new Date(s.resume_at).getTime()    > Date.now();
    const untilOk    = !!s?.paused_until && new Date(s.paused_until).getTime() > Date.now();
    const boolPaused = !!s?.paused;
    wasPaused = resumeOk || untilOk || boolPaused;
  } catch {}

  try {
    if (typeof clearPause === 'function') await clearPause(propertyId, conversationId);
  } catch (e) {
    console.error('[resume] clearPause failed', { conversationId, e });
  }

  try {
    await resetNegativeCount(propertyId, conversationId);
  } catch (e) {
    console.error('[resume] resetNegativeCount failed', { conversationId, e });
  }

  try {
    await updateConversationStatus(conversationId, 'open');
  } catch (e) {
    console.error('[resume] set open failed', { conversationId, e });
  }

  if (wasPaused) {
    try {
      await addPrivateMessage(conversationId, '▶️ Bot resumed');
    } catch (e) {
      console.error('[resume] private note failed', { conversationId, e });
    }
  } else {
    console.log('[resume] already resumed; skip duplicate note');
  }

  return { escalated: false, mode: 'resume' };
}

export async function resolveConversation(event: any) {
  const { conversationId, propertyId } = event;
  console.log('[escalation.resolve] start', { conversationId });

  try {
    await updateConversationStatus(conversationId, 'resolved');
  } catch (e) {
    console.error('[resolve] set resolved failed', { conversationId, e });
  }

  try {
    await addPrivateMessage(conversationId, '✅ Bot resolved');
  } catch (e) {
    console.error('[resolve] private note failed', { conversationId, e });
  }

  try {
    if (typeof clearState === 'function') await clearState(propertyId, conversationId);
  } catch (e) {
    console.error('[resolve] clearState failed', { conversationId, e });
  }

  return { escalated: false, mode: 'resolved' };
}

export const handleResume = resumeBot;
export const handleResolve = resolveConversation;
