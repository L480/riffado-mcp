/** Common shape both transports implement; `index.ts` picks one at startup. */
export interface RiffadoTransportServer {
  start(): Promise<void>
  stop(): Promise<void>
}
