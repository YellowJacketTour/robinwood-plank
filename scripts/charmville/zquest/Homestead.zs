#include "std.zh"
#include "ActionPalettes.zh"
#include "ExtraFollowerFrames.zh"

// Native, local tutorial prototype. No shared-account inventory authority.
// Active is the engine's global per-frame script slot.
global script Active
{
    void resetContactOutbox()
    {
        char32 text[32];int run=0;
        file previous=new file("/charmville/action-run.txt","r");
        if(previous->isValid()){previous->ReadString(text);previous->Close();run=atoi(text);}
        file cursor=new file("/charmville/action-sequence.txt","w");
        if(!cursor->isValid())return;
        sprintf(text,"0");cursor->WriteString(text);cursor->Close();
        file lifecycle=new file("/charmville/lifecycle-sequence.txt","w");if(lifecycle->isValid()){lifecycle->WriteString(text);lifecycle->Close();}
        file auth=new file("/charmville/resource-authorization.txt","w");if(auth->isValid())auth->Close();
        file position=new file("/charmville/position.txt","w");if(position->isValid())position->Close();
        file correction=new file("/charmville/position-correction.txt","w");if(correction->isValid())correction->Close();
        file generation=new file("/charmville/action-run.txt","w");
        if(!generation->isValid())return;
        sprintf(text,"%d",run+1);generation->WriteString(text);generation->Close();
    }
    void publishContact(int sequence,int action,int bed)
    {
        char32 path[80];char32 message[160];
        sprintf(path,"/charmville/action-%d.txt",sequence%64);
        file event=new file(path,"w");
        if(!event->isValid()){printf("CHARMVILLE_CONTACT_OUTBOX_ERROR %d\n",sequence);return;}
        sprintf(message,"%d|%d|%d|%d|%d|%d|%d|%d",sequence,action,bed,Game->GetCurDMap(),Game->GetCurScreen(),Hero->X,Hero->Y,Hero->Dir);
        event->WriteString(message);event->Close();
        file cursor=new file("/charmville/action-sequence.txt","w");
        if(!cursor->isValid()){printf("CHARMVILLE_CONTACT_OUTBOX_ERROR %d\n",sequence);return;}
        sprintf(message,"%d",sequence);cursor->WriteString(message);cursor->Close();
        printf("CHARMVILLE_CONTACT %d ACTION %d BED %d\n",sequence,action,bed);
    }
    void publishLifecycle(int sequence,int id,int phase,int action,int bed)
    {
        char32 path[80];char32 text[192];sprintf(path,"/charmville/lifecycle-%d.txt",sequence%64);
        file event=new file(path,"w");if(!event->isValid())return;
        sprintf(text,"%d|%d|%d|%d|%d|%d|%d|%d|%d|%d",sequence,id,phase,action,bed,Game->GetCurDMap(),Game->GetCurScreen(),Hero->X,Hero->Y,Hero->Dir);event->WriteString(text);event->Close();
        file cursor=new file("/charmville/lifecycle-sequence.txt","w");if(!cursor->isValid())return;sprintf(text,"%d",sequence);cursor->WriteString(text);cursor->Close();
        printf("CHARMVILLE_LIFECYCLE %d ID %d PHASE %d ACTION %d BED %d\n",sequence,id,phase,action,bed);
    }
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
        // Level CSets replace main-palette slots on the actual world screen.
        paldata level=new paldata();level->LoadLevelPalette(Game->DMapPalette[Game->GetCurDMap()]);
        for(int c=0;c<256;c++)if(level->R[c]>=0){world->R[c]=level->R[c];world->G[c]=level->G[c];world->B[c]=level->B[c];}
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
        hair->Read(0,"/charmville/gold-hair.png");
        bitmap pikachu=new bitmap();bitmap eevee=new bitmap();bitmap poochyena=new bitmap();
        bitmap treecko=new bitmap();bitmap torchic=new bitmap();bitmap mudkip=new bitmap();
        // Exact white ground-origin markers from PMD Walk-Shadow.png, row-major.
        int mudkipAnchorX[]={16,16,16,16,16,16,16,16,18,19,20,18,16,16,18,19,19,18,16,16,18,19,20,18,16,16,16,16,16,16,16,16,14,13,12,14,16,16,14,13,13,14,16,16,14,13,12,14};
        int mudkipAnchorY[]={24,25,26,27,27,26,24,24,25,26,27,26,24,24,24,24,24,24,24,24,23,22,21,22,24,24,23,22,21,22,24,24,23,22,21,22,24,24,24,24,24,24,24,24,25,26,27,26};
        pikachu->Read(0,"/charmville/follower-pikachu.png");eevee->Read(0,"/charmville/follower-eevee.png");poochyena->Read(0,"/charmville/follower-poochyena.png");
        treecko->Read(0,"/charmville/follower-treecko.png");torchic->Read(0,"/charmville/follower-torchic.png");mudkip->Read(0,"/charmville/follower-mudkip.png");Waitframe();
        int encounterVersion=0;int encounterVisible=0;int encounterX=0;int encounterY=0;int encounterHP=0;int encounterMaxHP=1;int encounterEffect=0;int encounterDamage=0;int encounterFlash=0;char32 encounterText[160];
        int followerSpacing=18;int follower=0;int partyFollowers[6];int lastFollowerDraw[6];int trailX[512];int trailY[512];int trailDir[512];int trailHead=0;int trailCount=0;int followerClock=0;
        int lastHeroX=Hero->X;int lastHeroY=Hero->Y;char32 followerText[64];
        resetContactOutbox();
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
        int sequence = 0;int positionSequence=0;int lastCorrection=0;int appliedCorrection=0;
        int activity=-1;int activityTick=0;int activityDir=DIR_DOWN;int lastToolFrame=-1;int contactSequence=0;
        bool resourceMode=false;bool resourceReady=false;int resourceVersion=0;int resourcePhase[3];int resourcePermissions[3];int resourceSeeds=0;int resourceProduce=0;char32 resourceText[192];
        int localActionId=0;int lifecycleSequence=0;bool lifecycleStarted=false;bool contactSent=false;int authorization=-1;int actionStartTick=0;bool pendingReceipt=false;bool alignmentDone=false;
        int activityLife=0;int activityX=0;int activityY=0;
        int previousDMap=Game->GetCurDMap(); int previousScreen=Game->GetCurScreen();
        int px[16]; int py[16]; int pt[16]; int pc[16]; int pf[16]; int pa[16]; int life[16];
        bool accountMode=false;int accountCount=0;int accountX[16];int accountY[16];int accountDirection[16];char32 accountText[512];
        char32 line[128];
        printf("CHARMVILLE_HOMESTEAD_ACTIVE\n");
        while (true)
        {
            ticks++;
            if(ticks==1 || ticks%6==0){
                file snapshot=new file("/charmville/resource-state.txt","r");
                if(snapshot->isValid()){
                    resourceText[0]=0;snapshot->ReadString(resourceText);snapshot->Close();int version=field(resourceText,0);
                    if(version>resourceVersion){
                        resourceMode=true;resourceVersion=version;resourceReady=field(resourceText,1)==1;resourceSeeds=field(resourceText,3);resourceProduce=field(resourceText,4);
                        for(int bed=0;bed<3;bed++){stages[bed]=field(resourceText,5+bed*2);resourcePhase[bed]=field(resourceText,6+bed*2);resourcePermissions[bed]=field(resourceText,11+bed);fed[bed]=false;}
                        if(field(resourceText,2)>=localActionId)pendingReceipt=false;
                        printf("CHARMVILLE_RESOURCE_STATE %d READY %d\n",version,resourceReady?1:0);
                    }
                }
                if(resourceMode && !resourceReady && activity>=0){if(lifecycleStarted && !contactSent){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,2,activity,selectedPlot);}activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;pendingReceipt=false;}
            }
            if(ticks==1 || ticks%15==0){
                file peers=new file("/charmville/account-peers.txt","r");
                if(peers->isValid()){
                    accountText[0]=0;peers->ReadString(accountText);peers->Close();
                    if(field(accountText,0)==1){int count=Min(16,Max(0,field(accountText,1)));if(!accountMode || count!=accountCount)printf("CHARMVILLE_ACCOUNT_PEERS %d\n",count);accountMode=true;accountCount=count;for(int p=0;p<16;p++)life[p]=0;
                        for(int p=0;p<accountCount;p++){accountX[p]=field(accountText,2+p*2);accountY[p]=field(accountText,3+p*2);int dir=field(accountText,2+accountCount*2+p);if(dir<0 || dir>3)dir=DIR_DOWN;if(dir!=accountDirection[p])printf("CHARMVILLE_PEER_FACING %d DIR %d\n",p,dir);accountDirection[p]=dir;}
                    }
                }
            }
            if(ticks%6==0){
                file correction=new file("/charmville/position-correction.txt","r");
                if(correction->isValid()){
                    line[0]=0;correction->ReadString(line);correction->Close();
                    int request=field(line,0);int map=field(line,1);int screen=field(line,2);int x=field(line,3);int y=field(line,4);int facing=field(line,5);
                    if(request>lastCorrection){
                        lastCorrection=request;
                        if(map==4 && screen==63 && Game->GetCurDMap()==map && Game->GetCurScreen()==screen && x>=0 && x<=240 && y>=0 && y<=160 && x%8==0 && y%8==0 && facing>=0 && facing<=3 && Hero->Z==0 && Hero->FakeZ==0){
                            if(resourceMode && activity>=0 && lifecycleStarted && !contactSent){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,2,activity,selectedPlot);}
                            activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;Hero->X=x;Hero->Y=y;Hero->Dir=facing;
                            trailCount=0;trailHead=0;lastHeroX=x;lastHeroY=y;farmSpawned=true;
                            appliedCorrection=request;
                            printf("CHARMVILLE_POSITION_CORRECTED %d X %d Y %d\n",request,x,y);
                        }
                    }
                }
            }
            if(ticks%6==0){
                file position=new file("/charmville/position.txt","w");
                if(position->isValid()){
                    positionSequence++;
                    sprintf(line,"%d|%d|%d|%f|%f|%d|%f|%f|%d",positionSequence,Game->GetCurDMap(),Game->GetCurScreen(),Hero->X,Hero->Y,Hero->Dir,Hero->Z,Hero->FakeZ,appliedCorrection);
                    position->WriteString(line);position->Close();
                }
            }
            if(ticks==60){int dirtColors[]={115,197,164,255,213,180,255,197,148,222,148,115,123,65,65,255,213,32,222,156,16,106,57,8,230,82,98,197,0,49,98,0,24,156,98,74,106,49,49,49,0,24,255,255,255,0,0,0};int sproutColors[]={115,197,164,255,213,180,255,197,148,222,148,115,123,65,65,205,205,222,156,156,189,74,74,123,115,189,0,65,123,0,16,57,0,205,98,74,148,57,41,82,16,0,255,255,255,0,0,0};int berryColors[]={115,197,164,255,213,180,255,197,148,222,148,115,123,65,65,255,164,180,213,106,123,139,65,82,148,197,246,90,139,189,16,49,82,180,164,98,123,115,65,57,57,24,255,255,255,0,0,0};matchPalette(dirt,dirtColors);matchPalette(sprout,sproutColors);matchPalette(berry,berryColors);matchPalette(hoeFG,hoe_fg_colors);matchPalette(hoeBG,hoe_bg_colors);matchPalette(waterFG,water_fg_colors);matchPalette(waterBG,water_bg_colors);matchPalette(hair,gold_hair_colors);matchPalette(treecko,follower_treecko_colors);matchPalette(torchic,follower_torchic_colors);matchPalette(mudkip,follower_mudkip_colors);matchPalette(pikachu,follower_pikachu_colors);matchPalette(eevee,follower_eevee_colors);matchPalette(poochyena,follower_poochyena_colors);}
            if(!accountMode && channel->State==WEBSOCKET_STATE_CLOSED && ticks%180==0)channel=new websocket("ws://localhost:3022");
            if(previousDMap!=Game->GetCurDMap() || previousScreen!=Game->GetCurScreen())
            {
                for(int p=0;p<16;p++)life[p]=0;
                if(resourceMode && activity>=0 && lifecycleStarted && !contactSent){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,2,activity,selectedPlot);}
                activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;
                clearingReady=false;trailCount=0;trailHead=0;lastHeroX=Hero->X;lastHeroY=Hero->Y;
                previousDMap=Game->GetCurDMap();previousScreen=Game->GetCurScreen();
            }
            if(!accountMode && channel->State == WEBSOCKET_STATE_OPEN && ticks%6==0)
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
            if(!accountMode)for(int p=0;p<16;p++)if(life[p]>0){life[p]--;if(pa[p])drawAura(px[p],py[p],ticks);Screen->DrawTile(2,px[p],py[p],pt[p],1,1,pc[p],-1,-1,0,0,0,pf[p]);}
            if(accountMode && Game->GetCurDMap()==4 && Game->GetCurScreen()==63)for(int p=0;p<accountCount;p++){
                // Pinned offline quest probe: left/right share tile20; left flips1.
                // Do not query unsupported GetOriginalFlip or reuse local facing.
                Screen->DrawTile(accountY[p]<Hero->Y?2:6,accountX[p],accountY[p],Hero->GetOriginalTile(0,accountDirection[p])+Hero->TileMod,1,1,Hero->CSet,-1,-1,0,0,0,accountDirection[p]==DIR_LEFT?1:0);
            }
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
                        if(resourceMode)sprintf(line,"Harvest Oran into your satchel.");else sprintf(line,"First crop opens guest play.");Screen->DrawString(6,4,141,0,1,-1,0,line);
                    }
                    sprintf(line,"E / D / Interact: continue");Screen->DrawString(6,4,160,0,1,-1,0,line);
                    if(Input->KeyPress[KEY_E] || Hero->PressEx3)welcome++;
                    Waitframe();continue;
                }
                int reachX=plotCenterX-(Hero->X+8);int reachY=plotCenterY-(Hero->Y+8);
                // One-tile tools must contact the selected bed, not work from
                // two tiles away or diagonally beyond the directional sprite.
                int requiredPermission=stages[selectedPlot]==4?8:(stages[selectedPlot]==2?4:(stages[selectedPlot]==1?2:1));
                bool permittedAction=!resourceMode || (resourcePermissions[selectedPlot]&requiredPermission)!=0;
                bool nearPlot = reachX*reachX+reachY*reachY<=400 && Min(Abs(reachX),Abs(reachY))<=8;
                if(Input->KeyPress[KEY_E] || Hero->PressEx3)printf("CHARMVILLE_INTERACT BED %d NEAR %d ACTION %d WORK %d Z %d FZ %d\n",selectedPlot+1,nearPlot?1:0,Hero->Action,activity,Hero->Z,Hero->FakeZ);
                if ((Input->KeyPress[KEY_E] || Hero->PressEx3) && nearPlot && permittedAction && Hero->Z==0 && Hero->FakeZ==0 && activity<0 && (!resourceMode || (resourceReady && !pendingReceipt)) && (stages[selectedPlot]!=3 || (!resourceMode && cuttings>0 && !fed[selectedPlot])) && (Hero->Action==LA_NONE || Hero->Action==LA_WALKING))
                {
                    activity=stages[selectedPlot]==3?5:stages[selectedPlot];activityTick=0;lastToolFrame=-1;
                    localActionId++;lifecycleStarted=false;contactSent=false;authorization=-1;actionStartTick=ticks;alignmentDone=false;
                    activityLife=Hero->HP;activityX=Hero->X;activityY=Hero->Y;
                    int dx=plotCenterX-(Hero->X+8);int dy=plotCenterY-(Hero->Y+8);
                    activityDir=Abs(dx)>Abs(dy)?(dx<0?DIR_LEFT:DIR_RIGHT):(dy<0?DIR_UP:DIR_DOWN);
                }
                // Damage, displacement, or a native action takes precedence over farming.
                // The classic controller aligns the perpendicular axis to its
                // 8px movement grid on a direction change. Accept that one
                // first-frame alignment, not later displacement or knockback.
                if(activity>=0 && activityTick==1 && !alignmentDone && Hero->HP==activityLife && Hero->Action==LA_NONE){
                    alignmentDone=true;
                    bool vertical=activityDir==DIR_UP || activityDir==DIR_DOWN;
                    if((vertical && Hero->Y==activityY && Abs(Hero->X-activityX)<8) || (!vertical && Hero->X==activityX && Abs(Hero->Y-activityY)<8)){
                        activityX=Hero->X;activityY=Hero->Y;
                    }
                }
                if(activity>=0 && (Hero->Z!=0 || Hero->FakeZ!=0 || Hero->HP<activityLife || Hero->X!=activityX || Hero->Y!=activityY || (Hero->Action!=LA_NONE && Hero->Action!=LA_WALKING)))
                {printf("CHARMVILLE_ACTION_CANCEL BED %d X %d/%d Y %d/%d HP %d/%d ACTION %d\n",selectedPlot+1,Hero->X,activityX,Hero->Y,activityY,Hero->HP,activityLife,Hero->Action);if(resourceMode && lifecycleStarted && !contactSent){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,2,activity,selectedPlot);}activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;}
                if(resourceMode && activity>=0 && activityTick==1){
                    if(!lifecycleStarted){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,0,activity,selectedPlot);lifecycleStarted=true;}
                    file auth=new file("/charmville/resource-authorization.txt","r");if(auth->isValid()){resourceText[0]=0;auth->ReadString(resourceText);auth->Close();if(field(resourceText,0)==localActionId){int decision=field(resourceText,1);if(authorization<0 && decision==1)activityTick=0;authorization=decision;}}
                    if(authorization==0 || ticks-actionStartTick>600){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,2,activity,selectedPlot);activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;}
                }
                if(activity>=0)
                {
                    Hero->InputUp=false;Hero->InputDown=false;Hero->InputLeft=false;Hero->InputRight=false;
                    Hero->InputAxisUp=false;Hero->InputAxisDown=false;Hero->InputAxisLeft=false;Hero->InputAxisRight=false;
                    Hero->InputA=false;Hero->InputB=false;Hero->PressA=false;Hero->PressB=false;
                    Hero->Dir=activityDir;
                    // A treasure hold-up is not a directional lifting/carrying pose.
                    // Native hammer uses the pound bank for the raised-tool windup.
                    // Reuse that complete directional body pose, then native stab for contact.
                    int pose=activity==0 && activityTick<14?6:((activityTick<14 || activityTick>=36)?0:1);
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
                    if((activity==0 || activity==2) && frame!=lastToolFrame){printf("CHARMVILLE_TOOL %d DIR %d FRAME %d\n",activity,activityDir,frame);lastToolFrame=frame;}
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
                        if(resourceMode){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,1,activity,selectedPlot);contactSent=true;pendingReceipt=true;}
                        else{
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
                        contactSequence++;publishContact(contactSequence,activity,selectedPlot);
                        }
                    }
                    if(!resourceMode || activityTick!=1 || authorization==1)activityTick++;
                    if(activityTick>=48){activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;printf("CHARMVILLE_ACTION_COMPLETE BED %d\n",selectedPlot+1);}
                }
                // Every bed advances independently; selection never owns the growth clock.
                for(int bed=0;bed<3;bed++){
                    if(!resourceMode && stages[bed]==3 && ticks-wateredTimes[bed]>=300){stages[bed]=4;printf("CHARMVILLE_CROP_READY BED %d\n",bed+1);}
                    int plantLayer=Hero->Y+16<plotFootY?6:2;
                    Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
                    if(stages[bed]==3){int age=resourceMode?resourcePhase[bed]*100:ticks-wateredTimes[bed];
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
                if(resourceMode && stages[selectedPlot]==3){if(resourcePhase[selectedPlot]==0)sprintf(line,"Sprouting... roots take hold");else if(resourcePhase[selectedPlot]==1)sprintf(line,"Growing... branches unfold");else sprintf(line,"Flowering... berries soon");}
                if(resourceMode && resourceReady && !permittedAction && stages[selectedPlot]!=3)sprintf(line,"Viewing this bed");
                if(resourceMode && !resourceReady)sprintf(line,"Join a place to tend these beds");
                else if(resourceMode && pendingReceipt)sprintf(line,"Waiting for the world...");
                else if(resourceMode && activity>=0 && authorization<0)sprintf(line,"Preparing your action...");
                Screen->DrawString(6,4,146,0,0x68,-1,0,line);
                int guests=0;for(int p=0;p<16;p++)if(life[p]>0)guests++;
                sprintf(line,"Bed %d  Berry %d  XP %d",selectedPlot+1,berries,harvests*10);
                if(resourceMode)sprintf(line,"Bed %d  Seeds %d  Oran %d",selectedPlot+1,resourceSeeds,resourceProduce);
                Screen->DrawString(6,4,157,0,0x01,-1,0,line);
                if(stages[selectedPlot]==3 && !fed[selectedPlot] && cuttings>0)sprintf(line,"D: feed soil (%d cuttings)",cuttings);
                else if(stages[selectedPlot]==3 && fed[selectedPlot])sprintf(line,"Fed soil: next yield is 2");
                else sprintf(line,"Cuttings %d Guests %d",cuttings,guests);
                if(resourceMode)sprintf(line,"Players nearby %d",accountCount);
                Screen->DrawString(6,4,168,0,0x01,-1,0,line);
            }
            // Parent supplies only a visual selection, never inventory authority.
            if(ticks%30==0){
                file preference=new file("/charmville/party-followers.txt","r");
                if(preference->isValid()){
                    followerText[0]=0;preference->ReadString(followerText);preference->Close();followerSpacing=field(followerText,6)==26?26:18;
                    for(int member=0;member<6;member++){
                        int next=field(followerText,member);if(next!=277 && next!=280 && next!=283 && next!=25 && next!=133 && next!=286)next=0;
                        if(next!=partyFollowers[member]){partyFollowers[member]=next;lastFollowerDraw[member]=0;if(member==0)printf("CHARMVILLE_FOLLOWER %d\n",next);}
                    }
                }
            }
            int stepX=Hero->X-lastHeroX;int stepY=Hero->Y-lastHeroY;
            if(Abs(stepX)>24 || Abs(stepY)>24){trailCount=0;trailHead=0;}
            else if(stepX!=0 || stepY!=0){
                trailX[trailHead]=Hero->X;trailY[trailHead]=Hero->Y;trailDir[trailHead]=Hero->Dir;
                trailHead=(trailHead+1)%512;trailCount=Min(trailCount+1,512);followerClock++;
            }
            lastHeroX=Hero->X;lastHeroY=Hero->Y;
            for(int member=5;member>=0;member--){
            follower=partyFollowers[member];if(follower==0)continue;
            // Follow eighteen world pixels along the visited path, independent
            // of movement speed. Interpolate only inside a recorded segment.
            int followerGap=followerSpacing*(member+1);int walked=0;int fx=Hero->X;int fy=Hero->Y;int direction=Hero->Dir;bool trailReady=false;
            for(int age=0;age<trailCount;age++){
                int trail=(trailHead+511-age)%512;
                int dx=trailX[trail]-fx;int dy=trailY[trail]-fy;
                int length=Sqrt(dx*dx+dy*dy);
                if(length>0 && walked+length>=followerGap){
                    int fraction=(followerGap-walked)/length;
                    fx+=dx*fraction;fy+=dy*fraction;direction=trailDir[trail];trailReady=true;break;
                }
                walked+=length;fx=trailX[trail];fy=trailY[trail];direction=trailDir[trail];
            }
            if(follower>0 && trailReady){
                if(lastFollowerDraw[member]!=follower){printf("CHARMVILLE_FOLLOWER_DRAW %d\n",follower);printf("CHARMVILLE_PARTY_DRAW %d %d\n",member,follower);lastFollowerDraw[member]=follower;}
                // PMD source rows: S,SE,E,NE,N,NW,W,SW. Draw unchanged walking frames.
                int row=direction==DIR_UP?4:(direction==DIR_LEFT?6:(direction==DIR_DOWN?0:2));
                int layer=fy+16<Hero->Y+16?2:6;
                Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
                // The recorded foot point is (fx+8,fy+16), plus the56px HUD.
                if(follower==25){int phase=(stepX==0 && stepY==0)?0:followerClock%36;int frame=phase<8?0:(phase<18?1:(phase<26?2:(3)));int anchor=row*4+frame;pikachu->Blit(layer,RT_SCREEN,frame*32,row*40,32,40,fx+8-pikachuAnchorX[anchor],fy+72-pikachuAnchorY[anchor],32,40);}
if(follower==133){int phase=(stepX==0 && stepY==0)?0:followerClock%26;int frame=phase<4?0:(phase<8?1:(phase<12?2:(phase<16?3:(phase<22?4:(phase<24?5:(6))))));int anchor=row*7+frame;eevee->Blit(layer,RT_SCREEN,frame*40,row*48,40,48,fx+8-eeveeAnchorX[anchor],fy+72-eeveeAnchorY[anchor],40,48);}
if(follower==286){int phase=(stepX==0 && stepY==0)?0:followerClock%20;int frame=phase<4?0:(phase<8?1:(phase<12?2:(phase<16?3:(4))));int anchor=row*5+frame;poochyena->Blit(layer,RT_SCREEN,frame*32,row*48,32,48,fx+8-poochyenaAnchorX[anchor],fy+72-poochyenaAnchorY[anchor],32,48);}
                if(follower==277){int phase=(stepX==0 && stepY==0)?0:followerClock%32;int frame=phase<6?0:(phase<16?1:(phase<22?2:3));treecko->Blit(layer,RT_SCREEN,frame*32,row*32,32,32,fx+8-16,fy+72-20,32,32);}
                if(follower==280){int frame=(stepX==0 && stepY==0)?0:Floor(followerClock/8)%4;torchic->Blit(layer,RT_SCREEN,frame*24,row*32,24,32,fx+8-12,fy+72-20,24,32);}
                if(follower==283){int phase=(stepX==0 && stepY==0)?0:followerClock%30;int frame=phase<4?0:(phase<10?1:(phase<14?2:(phase<20?3:(phase<26?4:5))));int anchor=row*6+frame;mudkip->Blit(layer,RT_SCREEN,frame*32,row*40,32,40,fx+8-mudkipAnchorX[anchor],fy+72-mudkipAnchorY[anchor],32,40);}
                Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            }
            }
            if(ticks%6==0){
                file encounterFile=new file("/charmville/world-encounter.txt","r");
                if(encounterFile->isValid()){
                    encounterText[0]=0;encounterFile->ReadString(encounterText);encounterFile->Close();
                    int version=field(encounterText,0);
                    if(version!=encounterVersion){bool established=encounterVersion>0;encounterVersion=version;encounterVisible=field(encounterText,1);encounterX=field(encounterText,2)*8;encounterY=field(encounterText,3)*8;encounterHP=field(encounterText,4);encounterMaxHP=Max(1,field(encounterText,5));
                        int effect=field(encounterText,6);if(established && effect>encounterEffect){encounterFlash=30;encounterDamage=field(encounterText,7);printf("CHARMVILLE_ENCOUNTER_EFFECT %d DAMAGE %d\n",effect,encounterDamage);}encounterEffect=effect;
                        printf("CHARMVILLE_ENCOUNTER_STATE %d HP %d/%d\n",encounterVisible,encounterHP,encounterMaxHP);
                    }
                }
            }
            if(encounterVisible==1 && Game->GetCurDMap()==4 && Game->GetCurScreen()==63){
                Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
                poochyena->Blit(encounterY<Hero->Y?2:6,RT_SCREEN,0,0,32,48,encounterX+8-poochyenaAnchorX[0],encounterY+72-poochyenaAnchorY[0],32,48);
                Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                Screen->Rectangle(6,encounterX-2,encounterY-12,encounterX+18,encounterY-9,0x00);
                if(encounterHP>0)Screen->Rectangle(6,encounterX-1,encounterY-11,encounterX-1+18*encounterHP/encounterMaxHP,encounterY-10,0x91);
                if(encounterFlash>0){sprintf(encounterText,"-%d",encounterDamage);Screen->DrawString(6,encounterX,encounterY-24-(30-encounterFlash)/3,0,0x01,-1,0,encounterText);}
            }
            if(encounterFlash>0)encounterFlash--;
            Waitframe();
        }
        Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
    }
}
