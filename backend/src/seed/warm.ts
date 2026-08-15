/* Pre-fetch every demo string through the LLM so the cache is committed and the
   stage demo runs with the wifi off. No-op without an API key. */
import { extractAddress, extractRoadPost } from '../services/parser.ts';

const ADDRESSES = [
  'رام الله، قرب مسجد جمال عبد الناصر، عمارة زيدان، الطابق الثالث، بجانب سوبر ماركت الأمل',
  'البيرة عمارة زيدان جنب سوبرماركت الامل ط٢',
  'رام الله، التحتا، قرب عمارة النتشة، فوق سوبرماركت الأمل، طابق 3، باب بني',
  'مخيم قلنديا، حارة الجامع، بعد محل أبو سمير للخضار، البيت اللي إله بوابة زرقا',
  'نابلس، رفيديا، خلف المستشفى العربي التخصصي، عمارة القصر، طابق ٤، الشقة اليسار',
  'بيت لحم، مخيم الدهيشة، مقابل مدرسة الأونروا، عمارة أبو عيشة، طابق ٢',
];
const POSTS = [
  'الوضع عالكونتينر مسكر بالكامل والبديل واد النار أزمة خانقة',
  'حاجز قلنديا سالك الحمدلله',
  'في حاجز طيار على مدخل المخيم انتبهوا',
];

const key = !!process.env.ANTHROPIC_API_KEY;
console.log(key ? 'warming LLM cache...' : 'no ANTHROPIC_API_KEY - nothing to warm (rule engine already works offline)');

for (const a of ADDRESSES) {
  const r = await extractAddress(a);
  console.log(`  [${r.engine}] ${a.slice(0, 46)}...`);
}
for (const p of POSTS) {
  const r = await extractRoadPost(p);
  console.log(`  [${r.engine}] ${p.slice(0, 46)}...`);
}
console.log('done.');
