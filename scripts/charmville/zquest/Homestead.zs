#include "std.zh"
#include "ActionPalettes.zh"

// Native, local tutorial prototype. No shared-account inventory authority.
// Active is the engine's global per-frame script slot.
global script Active
{
    void drawAura(int x,int y,int tick)
    {
        Screen->Ellipse(1,x+8,y+6,12+(tick/6)%2,20,0x68,1,0,0,0,false);
        for(int i=0;i<8;i++)
        {
            int phase=(tick*3+i*45)%360;
            int ax=x+8+Cos(phase)*13;
            int ay=y+8+Sin(phase)*18;
            Screen->Line(2,ax,ay,ax+(i%2==0?2:-2),ay-4-(tick+i)%4,0x68);
        }
    }
    // Remap source palette indices without changing the original PNG or world palette.
    void matchPalette(bitmap art, int[] colors)
    {
        Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
        // This quest uses legacy 6-bit palette channel values.
        paldata world=new paldata();world->LoadMainPalette();
        bitmap mask=new bitmap(art->Width,art->Height);
        art->Blit(0,mask,0,0,art->Width,art->Height,0,0,art->Width,art->Height,0,0,0,0,0,false);
        Waitframe();
        for(int i=1;i<SizeOfArray(colors)/3;i++){
            int best=1;int score=100000;
            for(int j=1;j<256;j++){
                int dr=world->R[j]-Floor(colors[i*3]/4);
                int dg=world->G[j]-Floor(colors[i*3+1]/4);
                int db=world->B[j]-Floor(colors[i*3+2]/4);
                int distance=dr*dr+dg*dg+db*db;
                if(distance<score){score=distance;best=j;}
            }
            art->MaskedDraw(0,mask,best,i);
        }
        Waitframe();
        Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
    }
    int field(char32[] text, int number)
    {
        int pos=0;
        while(number>0 && text[pos]!=0){if(text[pos]==124)number--;pos++;}
        return atoi(text,pos);
    }
    void run()
    {
        bitmap dirt=new bitmap();bitmap sprout=new bitmap();bitmap berry=new bitmap();
        dirt->Read(0,"/charmville/berry-dirt.png");sprout->Read(0,"/charmville/berry-sprout.png");berry->Read(0,"/charmville/berry-oran.png");
        bitmap hoeFG=new bitmap(); bitmap hoeBG=new bitmap();
        bitmap waterFG=new bitmap(); bitmap waterBG=new bitmap(); bitmap hair=new bitmap();
        hoeFG->Read(0,"/charmville/hoe-fg.png");hoeBG->Read(0,"/charmville/hoe-bg.png");
        waterFG->Read(0,"/charmville/water-fg.png");waterBG->Read(0,"/charmville/water-bg.png");
        hair->Read(0,"/charmville/gold-hair.png");Waitframe();
        // Slot 36's optional costume bank has broken casting frames in this quest.
        // Keep the sword's weapon art, damage and abilities; use the complete hero bank.
        itemdata masterSword=Game->LoadItemData(36);masterSword->TileMod=0;
        int stages[3];int selectedPlot=0;
        int plotXs[]={24,56,88};int plotY=88;int plotX=plotXs[0];int plotCenterX=plotX+8;int plotCenterY=plotY+8;int plotFootY=plotY+16;bool farmSpawned=false;bool clearingReady=false;
        int welcome = 0;

        int wateredTimes[3];
        int ticks = 0;
        int harvests = 0;int berries=0;int cuttings=0;bool fed[3];
        bool aura = false;
        websocket channel = new websocket("ws://localhost:3022");
        int sequence = 0;
        int activity=-1;int activityTick=0;int activityDir=DIR_DOWN;
        int activityLife=0;int activityX=0;int activityY=0;
        int previousDMap=Game->GetCurDMap(); int previousScreen=Game->GetCurScreen();
        int px[16]; int py[16]; int pt[16]; int pc[16]; int pf[16]; int pa[16]; int life[16];
        char32 line[128];
        printf("CHARMVILLE_HOMESTEAD_ACTIVE\n");
        while (true)
        {
            ticks++;
            if(ticks==60){int dirtColors[]={115,197,164,255,213,180,255,197,148,222,148,115,123,65,65,255,213,32,222,156,16,106,57,8,230,82,98,197,0,49,98,0,24,156,98,74,106,49,49,49,0,24,255,255,255,0,0,0};int sproutColors[]={115,197,164,255,213,180,255,197,148,222,148,115,123,65,65,205,205,222,156,156,189,74,74,123,115,189,0,65,123,0,16,57,0,205,98,74,148,57,41,82,16,0,255,255,255,0,0,0};int berryColors[]={115,197,164,255,213,180,255,197,148,222,148,115,123,65,65,255,164,180,213,106,123,139,65,82,148,197,246,90,139,189,16,49,82,180,164,98,123,115,65,57,57,24,255,255,255,0,0,0};matchPalette(dirt,dirtColors);matchPalette(sprout,sproutColors);matchPalette(berry,berryColors);matchPalette(hoeFG,hoe_fg_colors);matchPalette(hoeBG,hoe_bg_colors);matchPalette(waterFG,water_fg_colors);matchPalette(waterBG,water_bg_colors);matchPalette(hair,gold_hair_colors);}
            if(channel->State==WEBSOCKET_STATE_CLOSED && ticks%180==0)channel=new websocket("ws://localhost:3022");
            if(previousDMap!=Game->GetCurDMap() || previousScreen!=Game->GetCurScreen())
            {
                for(int p=0;p<16;p++)life[p]=0;
                activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;
                clearingReady=false;
                previousDMap=Game->GetCurDMap();previousScreen=Game->GetCurScreen();
            }
            if(channel->State == WEBSOCKET_STATE_OPEN && ticks%6==0)
            {
                sprintf(line,"world|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d",sequence,Hero->X,Hero->Y,Hero->Tile,Hero->CSet,Hero->Flip,Game->GetCurDMap(),Game->GetCurScreen(),harvests>0?1:0,aura?1:0);
                channel->Send(line);
                sequence++;
                while(channel->HasMessage)
                {
                    char32[] reply=channel->Receive();
                    int id=field(reply,1);
                    if(id>=0 && id<16 && field(reply,8)==Game->GetCurDMap() && field(reply,9)==Game->GetCurScreen()){px[id]=field(reply,2);py[id]=field(reply,3);pt[id]=field(reply,4);pc[id]=field(reply,5);pf[id]=field(reply,6);pa[id]=field(reply,7);life[id]=120;}
                }
            }
            for(int p=0;p<16;p++)if(life[p]>0){life[p]--;if(pa[p])drawAura(px[p],py[p],ticks);Screen->DrawTile(2,px[p],py[p],pt[p],1,1,pc[p],-1,-1,0,0,0,pf[p]);}
            if (Input->KeyPress[KEY_T] || Hero->PressEx4)
            {
                aura = !aura;
                printf("CHARMVILLE_AURA %d\n", aura);
            }
            if (aura)
            {
                // Native prototype effect; not imported DBZ animation frames.
                drawAura(Hero->X,Hero->Y,ticks);
                int hairRow=Hero->Dir==DIR_UP?8:(Hero->Dir==DIR_LEFT?9:(Hero->Dir==DIR_DOWN?10:11));
                int hairFrame=Hero->Action==LA_WALKING?Floor(ticks/8)%8:0;
                Screen->DrawOrigin=DRAW_ORIGIN_SCREEN; hair->Blit(6,RT_SCREEN,hairFrame*64,hairRow*64,64,64,Hero->X-8,Hero->Y+47,32,32); Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            }
            if (Game->GetCurDMap()==4 && Game->GetCurScreen()==63)
            {
                if(!clearingReady){
                    // Copy a verified clear native ground column, including every active overlay.
                    // Bounds avoid the boulder at x112 and all tree canopies.
                    for(int layer=0;layer<=6;layer++){
                        if(layer>0 && Screen->LayerMap[layer]<=0)continue;
                        int ground=GetLayerComboD(layer,105);int cset=GetLayerComboC(layer,105);
                        for(int row=4;row<=6;row++)for(int col=1;col<=6;col++){int cell=row*16+col;SetLayerComboD(layer,cell,ground);SetLayerComboC(layer,cell,cset);SetLayerComboF(layer,cell,0);}
                    }
                    int solid=0;for(int cell=65;cell<=102;cell++){if(cell%16>=1 && cell%16<=6)solid+=Screen->ComboS[cell];}clearingReady=true;printf("CHARMVILLE_FARM_CLEARING READY SOLID %d\n",solid);
                }
                if(!farmSpawned){Hero->X=16;Hero->Y=72;Hero->Dir=DIR_DOWN;farmSpawned=true;}
                if(activity<0){
                    int nearest=100000;for(int bed=0;bed<3;bed++){int dx=plotXs[bed]+8-(Hero->X+8);int dy=plotY+8-(Hero->Y+8);int distance=dx*dx+dy*dy;if(distance<nearest){nearest=distance;selectedPlot=bed;}}
                }
                plotX=plotXs[selectedPlot];plotCenterX=plotX+8;
                for(int bed=0;bed<3;bed++){Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;dirt->Blit(2,RT_SCREEN,0,0,16,16,plotXs[bed],plotY+56,16,16);Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;}

                if(welcome<2)
                {
                    Hero->InputUp=false;Hero->InputDown=false;Hero->InputLeft=false;Hero->InputRight=false;
                    Hero->InputAxisUp=false;Hero->InputAxisDown=false;Hero->InputAxisLeft=false;Hero->InputAxisRight=false;
                    Hero->InputA=false;Hero->InputB=false;Hero->PressA=false;Hero->PressB=false;
                    Screen->Rectangle(6,0,128,255,175,0);
                    if(welcome==0){
                        sprintf(line,"Welcome to the meadow!");Screen->DrawString(6,4,130,0,1,-1,0,line);
                        sprintf(line,"Start small. Grow together.");Screen->DrawString(6,4,141,0,1,-1,0,line);
                    }else{
                        sprintf(line,"Till, plant, water, harvest.");Screen->DrawString(6,4,130,0,1,-1,0,line);
                        sprintf(line,"First crop opens guest play.");Screen->DrawString(6,4,141,0,1,-1,0,line);
                    }
                    sprintf(line,"E / D / Interact: continue");Screen->DrawString(6,4,160,0,1,-1,0,line);
                    if(Input->KeyPress[KEY_E] || Hero->PressEx3)welcome++;
                    Waitframe();continue;
                }
                int reachX=plotCenterX-(Hero->X+8);int reachY=plotCenterY-(Hero->Y+8);
                bool nearPlot = reachX*reachX+reachY*reachY<=1024;
                if(Input->KeyPress[KEY_E] || Hero->PressEx3)printf("CHARMVILLE_INTERACT BED %d NEAR %d ACTION %d WORK %d Z %d FZ %d\n",selectedPlot+1,nearPlot?1:0,Hero->Action,activity,Hero->Z,Hero->FakeZ);
                if ((Input->KeyPress[KEY_E] || Hero->PressEx3) && nearPlot && Hero->Z==0 && Hero->FakeZ==0 && activity<0 && (stages[selectedPlot]!=3 || (cuttings>0 && !fed[selectedPlot])) && (Hero->Action==LA_NONE || Hero->Action==LA_WALKING))
                {
                    activity=stages[selectedPlot]==3?5:stages[selectedPlot];activityTick=0;
                    activityLife=Hero->HP;activityX=Hero->X;activityY=Hero->Y;
                    int dx=plotCenterX-(Hero->X+8);int dy=plotCenterY-(Hero->Y+8);
                    activityDir=Abs(dx)>Abs(dy)?(dx<0?DIR_LEFT:DIR_RIGHT):(dy<0?DIR_UP:DIR_DOWN);
                }
                // Damage, displacement, or a native action takes precedence over farming.
                // The classic controller aligns the perpendicular axis to its
                // 8px movement grid on a direction change. Accept that one
                // first-frame alignment, not later displacement or knockback.
                if(activity>=0 && activityTick==1 && Hero->HP==activityLife && Hero->Action==LA_NONE){
                    bool vertical=activityDir==DIR_UP || activityDir==DIR_DOWN;
                    if((vertical && Hero->Y==activityY && Abs(Hero->X-activityX)<8) || (!vertical && Hero->X==activityX && Abs(Hero->Y-activityY)<8)){
                        activityX=Hero->X;activityY=Hero->Y;
                    }
                }
                if(activity>=0 && (Hero->Z!=0 || Hero->FakeZ!=0 || Hero->HP<activityLife || Hero->X!=activityX || Hero->Y!=activityY || (Hero->Action!=LA_NONE && Hero->Action!=LA_WALKING)))
                {printf("CHARMVILLE_ACTION_CANCEL BED %d X %d/%d Y %d/%d HP %d/%d ACTION %d\n",selectedPlot+1,Hero->X,activityX,Hero->Y,activityY,Hero->HP,activityLife,Hero->Action);activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;}
                if(activity>=0)
                {
                    Hero->InputUp=false;Hero->InputDown=false;Hero->InputLeft=false;Hero->InputRight=false;
                    Hero->InputAxisUp=false;Hero->InputAxisDown=false;Hero->InputAxisLeft=false;Hero->InputAxisRight=false;
                    Hero->InputA=false;Hero->InputB=false;Hero->PressA=false;Hero->PressB=false;
                    Hero->Dir=activityDir;
                    // A treasure hold-up is not a directional lifting/carrying pose.
                    int pose=(activityTick<14 || activityTick>=36)?0:1;
                    Hero->ScriptTile=Hero->GetOriginalTile(pose,activityDir)+Hero->TileMod;
                    // Hosted player aborts on GetOriginalFlip; retain the native directional flip.
                    int row=activityDir==DIR_UP?4:(activityDir==DIR_LEFT?5:(activityDir==DIR_DOWN?6:7));
                    // LPC source_index.html defines watering as 0-1-4-4-4-4-5;
                    // columns 2 and 3 are empty. The hoe uses all eight thrust
                    // frames, with maximum extension aligned to contact tick 28.
                    int waterFrames[]={0,1,4,4,4,4,5};
                    int frame=activity==2?waterFrames[Min(Floor(activityTick/7),6)]:
                        (activityTick<6?0:(activityTick<12?1:(activityTick<18?2:(activityTick<22?3:(activityTick<28?4:(activityTick<36?5:(activityTick<42?6:7)))))));
                    // LPC foot baseline 60 at half scale aligns with Hero's
                    // 16px foot baseline: 16 - 30 = -14, plus the 56px HUD.
                    int toolY=Hero->Y+42;
                    Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
                    if(activity==0){hoeBG->Blit(1,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);hoeFG->Blit(6,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);}
                    if(activity==2){waterBG->Blit(1,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);waterFG->Blit(6,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);}
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                    // No held prop until a crop item has its own validated sprite identity.
                    if(activity==2 && activityTick>=18 && activityTick<36){
                        int spoutX=activityX+8+(activityDir==DIR_LEFT?-8:(activityDir==DIR_RIGHT?8:0));
                        int spoutY=activityY+8+(activityDir==DIR_UP?-8:(activityDir==DIR_DOWN?8:0));
                        for(int drop=0;drop<4;drop++){
                            int phase=(activityTick+drop*4)%18;
                            Screen->Circle(6,spoutX+(plotCenterX-spoutX)*phase/18,spoutY+(plotCenterY-spoutY)*phase/18,1,0x91);
                        }
                    }
                    if(activityTick==28)
                    {
                        if(activity==4){
                            int yield=fed[selectedPlot]?2:1;berries+=yield;cuttings++;harvests++;stages[selectedPlot]=1;fed[selectedPlot]=false;
                            printf("CHARMVILLE_HARVEST %d XP %d\n",harvests,harvests*10);
                            printf("CHARMVILLE_SATCHEL BERRIES %d CUTTINGS %d\n",berries,cuttings);
                        }
                        else if(activity==5){
                            if(stages[selectedPlot]==3 && cuttings>0 && !fed[selectedPlot]){cuttings--;fed[selectedPlot]=true;printf("CHARMVILLE_FERTILIZED CUTTINGS %d\n",cuttings);}
                        }
                        else{stages[selectedPlot]=activity+1;if(stages[selectedPlot]==3)wateredTimes[selectedPlot]=ticks;}
                        printf("CHARMVILLE_CROP_STAGE %d BED %d\n",stages[selectedPlot],selectedPlot+1);
                    }
                    activityTick++;
                    if(activityTick>=48){activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;printf("CHARMVILLE_ACTION_COMPLETE BED %d\n",selectedPlot+1);}
                }
                // Every bed advances independently; selection never owns the growth clock.
                for(int bed=0;bed<3;bed++){
                    if(stages[bed]==3 && ticks-wateredTimes[bed]>=300){stages[bed]=4;printf("CHARMVILLE_CROP_READY BED %d\n",bed+1);}
                    int plantLayer=Hero->Y+16<plotFootY?6:2;
                    Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
                    if(stages[bed]==3){int age=ticks-wateredTimes[bed];
                        if(age<100)sprout->Blit(2,RT_SCREEN,(Floor(ticks/32)%2)*16,0,16,16,plotXs[bed],plotY+56,16,16);
                        else if(age<200)berry->Blit(plantLayer,RT_SCREEN,(Floor(ticks/48)%2)*16,0,16,32,plotXs[bed],plotY+40,16,32);
                        else berry->Blit(plantLayer,RT_SCREEN,32+(Floor(ticks/64)%2)*16,0,16,32,plotXs[bed],plotY+40,16,32);
                    }
                    if(stages[bed]==4)berry->Blit(plantLayer,RT_SCREEN,64+(Floor(ticks/96)%2)*16,0,16,32,plotXs[bed],plotY+40,16,32);
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                }
                Screen->Rectangle(6,0,144,255,175,0x00);
                if (stages[selectedPlot]==0) sprintf(line,"E / D: prepare the soil");
                if (stages[selectedPlot]==1) sprintf(line,"E / D: plant a seed");
                if (stages[selectedPlot]==2) sprintf(line,"E / D: water the seed");
                if (stages[selectedPlot]==3){
                    if(ticks-wateredTimes[selectedPlot]<100)sprintf(line,"Sprouting... roots take hold");
                    else if(ticks-wateredTimes[selectedPlot]<200)sprintf(line,"Growing... branches unfold");
                    else sprintf(line,"Flowering... berries soon");
                }
                if (stages[selectedPlot]==4) sprintf(line,"E / D: gather your crop");
                Screen->DrawString(6,4,146,0,0x68,-1,0,line);
                int guests=0;for(int p=0;p<16;p++)if(life[p]>0)guests++;
                sprintf(line,"Bed %d  Berry %d  XP %d",selectedPlot+1,berries,harvests*10);
                Screen->DrawString(6,4,157,0,0x01,-1,0,line);
                if(stages[selectedPlot]==3 && !fed[selectedPlot] && cuttings>0)sprintf(line,"D: feed soil (%d cuttings)",cuttings);
                else if(stages[selectedPlot]==3 && fed[selectedPlot])sprintf(line,"Fed soil: next yield is 2");
                else sprintf(line,"Cuttings %d Guests %d",cuttings,guests);
                Screen->DrawString(6,4,168,0,0x01,-1,0,line);
            }
            Waitframe();
        }
        Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
    }
}











