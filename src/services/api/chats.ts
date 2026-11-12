import { apiClient } from './client';
import type { RoutingSession } from './routingActivity';

export type ChatBlockKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'context';

export interface ChatBlock {
  kind: ChatBlockKind;
  text?: string;
  name?: string;
  error?: boolean;
  truncated?: boolean;
}

export interface ChatMessage {
  seq: number;
  role: 'user' | 'assistant' | 'system' | string;
  at: string;
  blocks: ChatBlock[];
  /** Still streaming. */
  live?: boolean;
}

export interface ChatTranscriptResponse {
  session?: RoutingSession;
  /** Older messages the proxy did not keep. */
  omitted: number;
  messages: ChatMessage[] | null;
  version: number;
}

export interface ChatTranscriptUnchanged {
  unchanged: true;
  version: number;
}

export interface ChatFeedItem {
  session_id: string;
  message: ChatMessage;
}

export interface ChatFeedResponse {
  items: ChatFeedItem[];
  sessions: Record<string, RoutingSession>;
}

export const chatsApi = {
  /** A chat's conversation; answers `unchanged` while it is still at `version`. */
  transcript: (id: string, version?: number) =>
    apiClient.get<ChatTranscriptResponse | ChatTranscriptUnchanged>(
      '/observability/chats/transcript',
      { params: version === undefined ? { id } : { id, version } }
    ),
  /** Newest messages across all chats, newest first. */
  feed: (limit = 80, tools = false, origins: string[] = []) =>
    apiClient.get<ChatFeedResponse>('/observability/chats/feed', {
      params: {
        limit,
        ...(tools ? { tools: 1 } : {}),
        ...(origins.length ? { origin: origins.join(',') } : {}),
      },
    }),
};
