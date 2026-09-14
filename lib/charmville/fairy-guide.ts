import {cropLessons} from './journey-lessons';

/** Presentation only. A guide page cannot grant an item or complete a lesson. */
export type GuideAction = 'setup' | 'home' | 'play' | 'party' | 'public' | 'bag';
export type GuidePage = {id:string; speaker:string; title:string; text:string; instruction:string; action:GuideAction; label:string};
export const FAMILY_OPENING:readonly {speaker:string;text:string}[] = [
 {speaker:'Mother',text:'Seven already. We are so proud of you.'},
 {speaker:'Father',text:'The world awaits. Your sandwich has agreed to accompany you.'},
 {speaker:'Mother',text:'These Burning Heart seeds came from our first garden. Care for them. Share what grows.'},
 {speaker:'Your guide',text:'I shall help with the enormous questions. For the moment: which way is the gate?'},
 {speaker:'Mother',text:'You will learn much. Be kind while you learn it. Come home whenever you need us.'},
 {speaker:'Your guide',text:'Love is a good beginning. Now let us give it somewhere to grow.'},
];

export function fairyGuidePage(completed:readonly string[]|null,atHome:boolean):GuidePage {
 const page=(id:string,title:string,text:string,instruction:string,action:GuideAction,label:string):GuidePage=>({id,speaker:'Your guide',title,text,instruction,action,label});
 if(completed===null)return page('loading','Finding your place','A moment. Even a very small guide must consult the map.','Checking your saved journey…','play','Back to play');
 if(!completed.includes('home.claimed'))return page('home','Your story begins at home','A whole life to begin. Fortunately, we may begin with one small corner.','Set up your account’s home. Your saved belongings stay with you.','setup','Set up my home');
 const lessons=cropLessons(completed);
 if(!lessons.harvested&&!atHome)return page('return','There and home again','The world will keep. Your first little garden is waiting.','Return home to learn soil, seeds, water and gathering.','home','Return home');
 if(!lessons.harvested&&!lessons.tilled)return page('soil','A place for love to grow','Earth is wonderfully patient. It still appreciates a little preparation.','Walk to a marked planting bed. Use the action shown to prepare soil.','play','Go to my beds');
 if(!lessons.harvested&&!lessons.planted)return page('seed','One seed, one beginning','Do not be alarmed by its size. Most worthwhile things begin smaller than expected.','Plant a seed in prepared soil. Your family gift below contains Burning Heart seeds when available.','play','Plant a seed');
 if(!lessons.harvested&&!lessons.watered)return page('water','Care makes the difference','Encouragement is splendid. This particular plant also requires water.','Approach a planted bed and use its Water action. Check its current condition first.','play','Water my plant');
 if(!lessons.harvested)return page('harvest','Let it grow','Patience is doing something useful while the universe attends to its roots.','A growing crop needs time. Gather it when ripe; its harvest goes into your Bag.','play','Check my plant');
 if(!completed.includes('partner.chosen'))return page('partner','Room for a friend','You have grown something. You need not grow up alone.','Choose your first partner in Party. Walk with me lets that companion follow you.','party','Choose a partner');
 return page('together','Take your kindness with you','There is a great deal of world. We shall meet it one friend at a time.','Visit the shared meadow, or open your Bag to see what you grew.','public','Meet other players');
}
