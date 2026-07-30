// Общая реализация нужна и renderer, и main-process IPC: иначе модифицированный renderer мог
// обойти визуальный zxcvbn-гейт и передать слабый пароль прямо в vault:initialize/changePassword.
export {
  checkStrength,
  formatCrackTime,
  masterPasswordPolicyError,
  MIN_PASSWORD_SCORE
} from '../../../shared/password-strength'
export type { ZxcvbnResult } from '../../../shared/password-strength'
