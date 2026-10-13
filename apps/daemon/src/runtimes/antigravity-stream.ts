type JsonObject = Record<string, unknown>;
type Emit = (event: JsonObject) => void;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function content(value: unknown): string {
  if (typeof value === 'string') return value;
  return value == null ? '' : JSON.stringify(value);
}

// agy's stream-json protocol uses event/init/step_update/result envelopes,
// distinct from Gemini CLI's type/message/tool_use protocol.
export function createAntigravityEventMapper(emit: Emit) {
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  let lastResponseStep: unknown = null;
  let lastResponseText = '';

  return (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (value.event === 'init') {
      const init = isRecord(value.init) ? value.init : {};
      emit({ type: 'status', label: 'initializing',
        sessionId: value.conversation_id ?? null,
        ...(typeof init.model === 'string' ? { model: init.model } : {}),
      });
      return true;
    }
    if (value.event === 'step_update' && isRecord(value.step_update)) {
      const step = value.step_update;
      if (step.step_type === 'user_input') return true;
      if (step.step_type === 'agent_response') {
        if (lastResponseStep !== step.step_index) {
          lastResponseStep = step.step_index;
          lastResponseText = '';
        }
        if (typeof step.text_delta === 'string' && step.text_delta) {
          lastResponseText += step.text_delta;
          emit({ type: 'text_delta', delta: step.text_delta });
        } else {
          emit({ type: 'status', label: 'generating' });
        }
        return true;
      }
      if (step.step_type === 'tool') {
        const info = isRecord(step.tool_info) ? step.tool_info : {};
        const name = typeof info.name === 'string' ? info.name : step.tool_name;
        if (typeof name !== 'string' || typeof step.step_index !== 'number') {
          emit({ type: 'status', label: 'tool_call' });
          return true;
        }
        const id = `${step.conversation_id ?? value.conversation_id ?? 'antigravity'}:${step.step_index}`;
        if (!toolUses.has(id)) {
          toolUses.add(id);
          emit({ type: 'tool_use', id, name, input: info.parameters ?? null });
        } else if (step.state !== 'DONE') {
          emit({ type: 'status', label: 'tool_call_update' });
        }
        if (step.state === 'DONE' && !toolResults.has(id)) {
          toolResults.add(id);
          const error = isRecord(info.error) ? info.error : null;
          emit({ type: 'tool_result', toolUseId: id,
            content: content(info.output ?? error?.message ?? info.error),
            isError: Boolean(info.error),
          });
        }
        return true;
      }
      emit({ type: 'status', label: 'running' });
      return true;
    }
    if (value.event === 'result' && isRecord(value.result)) {
      const result = value.result;
      const isError = result.status !== 'SUCCESS';
      if (isError) {
        const error = isRecord(result.error) ? result.error.message : result.error;
        emit({ type: 'error', message: content(error) || `Antigravity ended with status ${content(result.status) || 'unknown'}` });
      } else if (typeof result.response === 'string' && result.response) {
        const delta = result.response.startsWith(lastResponseText)
          ? result.response.slice(lastResponseText.length)
          : `${lastResponseText ? '\n\n' : ''}${result.response}`;
        if (delta) emit({ type: 'text_delta', delta });
      }
      if (isRecord(result.usage)) {
        const usage: JsonObject = {};
        for (const [native, normalized] of [
          ['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
          ['thinking_tokens', 'thought_tokens'], ['cache_read_tokens', 'cached_read_tokens'],
        ] as const) {
          if (typeof result.usage[native] === 'number') usage[normalized] = result.usage[native];
        }
        emit({ type: 'usage', usage, isError,
          durationMs: typeof result.duration_seconds === 'number' ? result.duration_seconds * 1000 : null,
        });
      }
      return true;
    }
    return false;
  };
}
