import type { Message, Role } from '@/core/types.ts';

export class Session {
  private messages: Message[] = [];

  append(role: Role, content: string): void {
    this.messages.push({ role, content });
  }

  toMessages(systemPrompt: string): Message[] {
    const messages: Message[] = [];
    if (systemPrompt !== '') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    return messages.concat(this.messages);
  }
}
