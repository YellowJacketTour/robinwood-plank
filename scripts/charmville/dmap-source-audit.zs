#include "std.zh"
global script Active
{
 void run()
 {
  printf("DMAP_AUDIT_START maps=%d slots=%d\n",Game->MapCount,MAX_DMAPS);
  for(int d=0;d<MAX_DMAPS;d++)
  {
   dmapdata dm=Game->LoadDMapData(d);
   int name[128];int title[128];int music[256];
   dm->GetName(name);dm->GetTitle(title);dm->GetMusic(music);
   printf("DMAP_ENTRY|%d|%d|%d|%d|%d|%d|%d|%d|%s|%s|%s\n",d,dm->Map,dm->Offset,dm->Type,dm->Palette,dm->MIDI,dm->Continue,dm->Level,name,title,music);
  }
  for(int m=1;m<=Game->MapCount;m++)for(int s=0;s<128;s++)
  {
   mapdata room=Game->LoadMapData(m,s);
   if((room->Valid&1)==0)continue;
   int nonzero=0;int solid=0;int enemies=0;int centerOpen=0;
   for(int c=0;c<176;c++){if(room->ComboD[c]>0)nonzero++;if((room->ComboS[c]&15)==15)solid++;if(c>=67 && c<=108 && (room->ComboS[c]&15)==0)centerOpen++;}
   for(int e=0;e<10;e++)if(room->Enemy[e]>0)enemies++;
   if(nonzero>0)printf("DMAP_ROOM|%d|%d|%d|%d|%d|%d|%d|%d\n",m,s,room->Palette,room->RoomType,nonzero,solid,enemies,centerOpen);
  }
  printf("DMAP_AUDIT_DONE\n");
  while(true)Waitframe();
 }
}
