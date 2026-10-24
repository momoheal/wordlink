/** /api/ai/chat 响应里的 SSE 事件（浏览器端可用，不依赖服务器模块） */
export type ChatEvent =
    | { type: 'session'; id: string; title?: string }
    | { type: 'text'; content: string }
    | { type: 'error' };

/** 逐个读出 /api/ai/chat 的事件，读到 [DONE] 结束。一个事件可能被拆在两个网络包里：只解析完整的行 */
export async function* readChatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') return;
                let event: ChatEvent;
                try {
                    event = JSON.parse(data);
                } catch {
                    continue;
                }
                yield event;
            }
        }
    } finally {
        // 调用方中途退出（出错、停止）时断开连接，服务器随之停止上游生成
        await reader.cancel().catch(() => {});
    }
}
