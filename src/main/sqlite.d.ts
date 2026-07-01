// better-sqlite3-multiple-ciphers is API-compatible with better-sqlite3,
// so reuse its type definitions (@types/better-sqlite3).
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('better-sqlite3')
  export = Database
}
