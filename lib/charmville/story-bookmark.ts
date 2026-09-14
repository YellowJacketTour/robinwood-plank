import {FAMILY_OPENING} from './fairy-guide';

export type StoryBookmark={version:1;page:number;finished:boolean};
/** Browser preference, never an accomplishment or authoritative story checkpoint. */
export function storyBookmarkKey(profileId:string):string|null {
 return /^[1-9][0-9]{0,18}$/.test(profileId)?`charmville:family-reading:v1:${profileId}`:null;
}
export function parseStoryBookmark(raw:string|null):StoryBookmark|null {
 if(raw===null||raw.length>256)return null;
 try {
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['version','page','finished'].includes(key))||value.version!==1||!Number.isInteger(value.page)||value.page<0||value.page>=FAMILY_OPENING.length||typeof value.finished!=='boolean')return null;
  return {version:1,page:value.page,finished:value.finished};
 } catch{return null;}
}
