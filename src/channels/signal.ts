import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private apiUrl: string;
  private phoneNumber: string;
  private opts: SignalChannelOpts;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl;
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    logger.info({ apiUrl: this.apiUrl, phoneNumber: this.phoneNumber }, 'Signal channel connect stub');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    logger.info({ jid, length: text.length }, 'Signal sendMessage stub');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('Signal channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Stub: Signal typing indicator not yet implemented
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_API_URL', 'SIGNAL_PHONE_NUMBER']);
  const apiUrl =
    process.env.SIGNAL_API_URL || envVars.SIGNAL_API_URL || '';
  const phoneNumber =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER || '';

  if (!apiUrl) {
    logger.warn('Signal: SIGNAL_API_URL not set');
    return null;
  }
  if (!phoneNumber) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER not set');
    return null;
  }

  return new SignalChannel(apiUrl, phoneNumber, opts);
});
