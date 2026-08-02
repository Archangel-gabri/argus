// Матчеры jest-dom (toBeInTheDocument и прочие) добавляются к expect в рантайме через
// test/setup-dom.ts. Этот файл говорит о них компилятору — иначе `npm run typecheck`
// ругается на существующие и работающие проверки.
import '@testing-library/jest-dom/vitest'
