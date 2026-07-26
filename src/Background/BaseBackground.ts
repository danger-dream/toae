export interface ILogger {
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

export type UnlistenFn = () => void

export interface IMenuItem {
  label: string
  checked?: boolean
  payload?: unknown
}

export interface IMenuOptions {
  position: { x: number; y: number }
  items: IMenuItem[]
}

export enum ResponseType {
  JSON = 1,
  Text = 2,
  Binary = 3
}

export interface IRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  timeout?: number
  query?: Record<string, unknown>
  body?: unknown
  text?: string
  form?: Record<string, unknown>
  responseType?: ResponseType
}

export interface IResponse<T> {
  ok: boolean
  status: number
  data: T
}

export function handlerLoggerMsg(message: string, args: unknown[]): string {
  let index = 0
  return message.replace(/{}/g, () => {
    const value = args[index++]
    try { return JSON.stringify(value) } catch { return String(value) }
  })
}
