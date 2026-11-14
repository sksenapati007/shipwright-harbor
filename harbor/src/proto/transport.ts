// What the client needs from a link: whole frames in, whole frames out. No BLE types leak past this file.

export interface Transport {
  /** Negotiated ATT MTU; frames never exceed mtu - 3 bytes. */
  readonly mtu: number;
  /** Send one frame (one ATT write). Resolves when the radio took it; rejects if the link is down. */
  send(frame: Uint8Array): Promise<void>;
  /** Frames from the device, in order. Returns an unsubscribe function. */
  onFrame(cb: (frame: Uint8Array) => void): () => void;
  /** Link dropped (or close() was called). Fires once. Returns an unsubscribe function. */
  onClose(cb: (reason?: string) => void): () => void;
  close(): void;
}
