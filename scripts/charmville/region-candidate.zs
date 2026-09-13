#include "std.zh"

// Isolated engine proof only. Do not attach to the live tutorial.
// Bounded 2x2 region of audited authored screens: 46, 47, 62, 63.
// Full Homestead gameplay assumes screen-local coordinates and is omitted.
global script Active
{
    void run()
    {
        dmapdata homestead = Game->LoadDMapData(4);
        int map = homestead->Map;
        int startingScreen = Game->HeroScreen;
        for(int screen=46;screen<=63;screen++)
        {
            if(screen!=46 && screen!=47 && screen!=62 && screen!=63)continue;
            mapdata room=Game->LoadMapData(map,screen);
            if(!room->Valid){printf("REGION_CANDIDATE_INVALID_ROOM screen=%d\n",screen);return;}
            int nonzero=0;
            for(int combo=0;combo<176;combo++)if(room->ComboD[combo]>0)nonzero++;
            printf("REGION_CANDIDATE_ROOM screen=%d valid=%d roomType=%d nonzero=%d firstCombo=%d centerCombo=%d\n",screen,room->Valid,room->RoomType,nonzero,room->ComboD[0],room->ComboD[88]);
        }
        int used[10];
        for(int screen=0;screen<128;screen++)
        {
            int existing=Game->LoadMapData(map,screen)->RegionID;
            if(existing>0 && existing<10)used[existing]=1;
        }
        int region=1;
        while(region<10 && used[region])region++;
        if(region==10){printf("REGION_CANDIDATE_NO_FREE_ID\n");return;}
        Game->LoadMapData(map,46)->RegionID=region;
        Game->LoadMapData(map,47)->RegionID=region;
        Game->LoadMapData(map,62)->RegionID=region;
        Game->LoadMapData(map,63)->RegionID=region;
        printf("REGION_CANDIDATE_AUTHORED dmap=4 map=%d offset=%d topLeft=46 topRight=47 bottomLeft=62 bottomRight=63 id=%d\n",map,homestead->Offset,region);
        // Canonical changes take effect on the next screen load.
        // Reload the requested arrival screen, never a different destination.
        // The launch URL chooses the spawn; region setup must not override it.
        Hero->Warp(4,startingScreen);
        for(int tick=0;tick<120;tick++)Waitframe();
        printf("REGION_CANDIDATE_LOADED dmap=%d map=%d origin=%d id=%d width=%d height=%d screensX=%d screensY=%d heroX=%d heroY=%d\n",Game->GetCurDMap(),Game->GetCurMap(),Game->GetCurScreen(),Region->ID,Region->Width,Region->Height,Region->ScreenWidth,Region->ScreenHeight,Hero->X,Hero->Y);
        printf("REGION_CANDIDATE_DONE\n");
        while(true)Waitframe();
    }
}


