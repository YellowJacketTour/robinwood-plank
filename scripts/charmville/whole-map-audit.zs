#include "std.zh"
global script Active
{
 void run()
 {
  dmapdata dm=Game->LoadDMapData(4);
  int map=dm->Map;
  printf("WHOLE_MAP_META dmap=4 map=%d offset=%d type=%d\n",map,dm->Offset,dm->Type);
  for(int s=0;s<128;s++)
  {
   mapdata room=Game->LoadMapData(map,s);
   int nonzero=0; int enemies=0; int layers=0; int allSolid=0;
   for(int c=0;c<176;c++)if(room->ComboD[c]>0)nonzero++;
   for(int c=0;c<176;c++)if((room->ComboS[c]&15)==15)allSolid++;
   for(int e=0;e<10;e++)if(room->Enemy[e]>0)enemies++;
   for(int l=1;l<=6;l++)if(room->LayerMap[l]>0)layers++;
   printf("WHOLE_MAP_ROOM screen=%d valid=%d nonzero=%d roomType=%d region=%d firstCombo=%d centerCombo=%d enemies=%d layers=%d allSolid=%d\n",s,room->Valid,nonzero,room->RoomType,room->RegionID,room->ComboD[0],room->ComboD[88],enemies,layers,allSolid);
   for(int layer=0;layer<=6;layer++)
   {
    int layerMap=map; int layerScreen=s;
    if(layer>0){layerMap=room->LayerMap[layer];layerScreen=room->LayerScreen[layer];}
    if(layerMap<=0)continue;
    mapdata terrain=Game->LoadMapData(layerMap,layerScreen);
    printf("WHOLE_MAP_LAYER screen=%d layer=%d map=%d sourceScreen=%d\n",s,layer,layerMap,layerScreen);
    for(int cell=0;cell<176;cell++)printf("WHOLE_MAP_CELL screen=%d layer=%d cell=%d combo=%d cset=%d solidity=%d type=%d flag=%d\n",s,layer,cell,terrain->ComboD[cell],terrain->ComboC[cell],terrain->ComboS[cell],terrain->ComboT[cell],terrain->ComboF[cell]);
   }
   for(int w=0;w<4;w++)printf("WHOLE_MAP_WARP screen=%d slot=%d tileType=%d tileDmap=%d tileScreen=%d sideType=%d sideDmap=%d sideScreen=%d\n",s,w,room->TileWarpType[w],room->TileWarpDMap[w],room->TileWarpScreen[w],room->SideWarpType[w],room->SideWarpDMap[w],room->SideWarpScreen[w]);
  }
  printf("WHOLE_MAP_DONE\n");
  while(true)Waitframe();
 }
}

