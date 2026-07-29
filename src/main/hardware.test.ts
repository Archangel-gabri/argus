// Разбор дисков на РЕАЛЬНОМ выводе lsblk: строки сняты с живой машины и дополнены
// типовым облачным диском, у которого модели нет вовсе.
import { parseDisks } from './hardware'

const rows = [
  'zram0      8589934592              0 disk',
  'nvme0n1 1024209543168 RS1D0TSSD710 0 disk',
  'vda      42949672960              1 disk', // облачный диск БЕЗ модели — раньше терялся целиком
  'sda     500107862016 Samsung SSD 860 EVO 500GB 0 disk', // модель с пробелами
  'sr0       1073741824              1 rom'
]
const r = parseDisks(rows)
const checks: Array<[string, boolean]> = [
  ['облачный диск без модели не потерян', r.some((d) => d.name === 'vda' && d.sizeGb === 43)],
  ['у него нет выдуманной модели', r.find((d) => d.name === 'vda')?.model === undefined],
  ['модель с пробелами собрана целиком', r.find((d) => d.name === 'sda')?.model === 'Samsung SSD 860 EVO 500GB'],
  ['nvme распознан как SSD', r.find((d) => d.name === 'nvme0n1')?.ssd === true],
  ['vda с ROTA=1 помечен как вращающийся', r.find((d) => d.name === 'vda')?.ssd === false],
  ['zram отброшен', !r.some((d) => d.name === 'zram0')],
  ['привод (rom) отброшен', !r.some((d) => d.name === 'sr0')],
  ['всего 3 диска', r.length === 3]
]
let bad = 0
for (const [n, c] of checks) {
  console.log(`  ${c ? '✔' : '✖'} ${n}`)
  if (!c) bad++
}
console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВСЁ СОШЛОСЬ')
process.exit(bad ? 1 : 0)
