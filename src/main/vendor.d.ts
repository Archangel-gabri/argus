// guacamole-lite не поставляет типов — минимальная декларация под наш вызов.
declare module 'guacamole-lite' {
  export default class GuacamoleLite {
    constructor(websocketOptions: unknown, guacdOptions: unknown, clientOptions: unknown)
    close?(): void
  }
}
