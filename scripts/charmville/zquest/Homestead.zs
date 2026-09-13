#include "std.zh"
#include "ActionPalettes.zh"
#include "ExtraFollowerFrames.zh"
#include "FollowerScale.zh"
#include "CommittedAttackFrames.zh"
#include "CaptureBall.zh"
#include "FaintFrames.zh"

// Native, local tutorial prototype. No shared-account inventory authority.
// Active is the engine's global per-frame script slot.
global script Active
{
    int behindHeroLayer(){return IsBackgroundLayer(2)?1:2;}
    // Strict membership: the bundled IncludesScreen helper admits equality
    // at the far edge. A correction must never address the next rectangle.
    bool loadedRoom(int dmap,int screen)
    {
        if(Game->GetCurDMap()!=dmap || screen<0 || screen>=128)return false;
        int origin=Game->GetCurScreen();
        int dx=screen%16-origin%16;int dy=Floor(screen/16)-Floor(origin/16);
        return dx>=0 && dy>=0 && dx<Max(1,Region->ScreenWidth) && dy<Max(1,Region->ScreenHeight);
    }
    // Conservative presentation footprint: sample all 8px quadrants.
    bool followerSpace(int x,int y)
    {
        // Physical bounds are independent of the fixed HUD and moving camera.
        // isSolid resolves region-world pixels through native _walkflag.
        if(x<0 || y<0 || x>Region->Width-16 || y>Region->Height-16)return false;
        for(int px=0;px<=15;px+=5)for(int py=0;py<=15;py+=5)
            if(Screen->isSolid(x+px,y+py))return false;
        return true;
    }
    bool followerSegment(int x,int y,int nx,int ny)
    {
        int distance=Max(Abs(nx-x),Abs(ny-y));
        int samples=Max(1,Ceiling(distance/4));
        for(int sample=1;sample<=samples;sample++)
            if(!followerSpace(x+(nx-x)*sample/samples,y+(ny-y)*sample/samples))return false;
        return true;
    }
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
        file introState=new file("/charmville/tutorial-state.txt","w");if(introState->isValid()){introState->WriteString(text);introState->Close();}
        file tutorial=new file("/charmville/tutorial-completed.txt","w");if(tutorial->isValid()){tutorial->WriteString(text);tutorial->Close();}
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
        // Action wire geometry stays source-room-local, like position admission.
        int room=Game->HeroScreen;
        sprintf(message,"%d|%d|%d|%d|%d|%d|%d|%d",sequence,action,bed,Game->GetCurDMap(),room,Hero->X-Region->WorldOffsetX(room),Hero->Y-Region->WorldOffsetY(room),Hero->Dir);
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
        int room=Game->HeroScreen;
        sprintf(text,"%d|%d|%d|%d|%d|%d|%d|%d|%d|%d",sequence,id,phase,action,bed,Game->GetCurDMap(),room,Hero->X-Region->WorldOffsetX(room),Hero->Y-Region->WorldOffsetY(room),Hero->Dir);event->WriteString(text);event->Close();
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
    void publishEquipment()
    {
        char32 nameA[256];char32 nameB[256];char32 status[600];
        int a=Hero->ItemA;int b=Hero->ItemB;
        // Read the authored quest identity, never infer it from a default kit.
        if(a>=0){itemdata itemA=Game->LoadItemData(a);itemA->GetName(nameA);}
        if(b>=0){itemdata itemB=Game->LoadItemData(b);itemB->GetName(nameB);}
        for(int i=0;i<256;i++){
            if(nameA[i]==10 || nameA[i]==13)nameA[i]=32;
            if(nameB[i]==10 || nameB[i]==13)nameB[i]=32;
        }
        sprintf(status,"%d|%d\n%s\n%s",a,b,nameA,nameB);
        file equipment=new file("/charmville/equipment-state.txt","w");
        if(equipment->isValid()){equipment->WriteString(status);equipment->Close();}
    }
    // Remap source palette indices without changing the original PNG or world palette.
    void matchPalette(bitmap art, int[] colors)
    {
        Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
        // Match the quest's scripting color range rather than assuming 6-bit.
        int colorScale=Game->FFRules[qr_SCRIPTS_6_BIT_COLOR]?4:1;
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
                int dr=world->R[j]-Floor(colors[i*3]/colorScale);
                int dg=world->G[j]-Floor(colors[i*3+1]/colorScale);
                int db=world->B[j]-Floor(colors[i*3+2]/colorScale);
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
        bitmap attackTreecko=new bitmap();bitmap attackTorchic=new bitmap();bitmap attackMudkip=new bitmap();attackTreecko->Read(0,"/charmville/attack-treecko.png");attackTorchic->Read(0,"/charmville/attack-torchic.png");attackMudkip->Read(0,"/charmville/attack-mudkip.png");bitmap attackPikachu=new bitmap();attackPikachu->Read(0,"/charmville/attack-pikachu.png");bitmap attackEevee=new bitmap();attackEevee->Read(0,"/charmville/attack-eevee.png");bitmap attackPoochyena=new bitmap();attackPoochyena->Read(0,"/charmville/attack-poochyena.png");
        bitmap captureBall=new bitmap();captureBall->Read(0,"/charmville/capture-ball.png");
        int captureSeq=0;int captureClock=-1;int captureFromX=0;int captureFromY=0;int captureToX=0;int captureToY=0;int captureWon=0;int captureShakes=0;char32 captureText[96];
        bool attackJustStarted=false;int attackSlot=-1;int followerX[6];int followerY[6];bool followerVisible[6];int attackAcknowledged=0;int attackSpecies=0;int attackClock=-1;int attackX=0;int attackY=0;int attackRow=0;int attackTotal=0;int attackHit=0;
        bitmap faintPoochyena=new bitmap();faintPoochyena->Read(0,"/charmville/faint-poochyena.png");int faintClock=-1;bool defeatPending=false;
        int encounterGeneration=0;int encounterVersion=0;int encounterVisible=0;int encounterX=0;int encounterY=0;int encounterHP=0;int encounterMaxHP=1;int encounterEffect=0;int encounterDamage=0;int encounterFlash=0;char32 encounterText[160];
        int followerSpacing=18;int resolvedFollowerSpacing=16;int follower=0;int partyFollowers[6];int lastFollowerDraw[6];int trailX[512];int trailY[512];int trailDir[512];int trailHead=0;int trailCount=0;int followerClock=0;
        int lastHeroX=Hero->X;int lastHeroY=Hero->Y;bool followerScrolling=false;char32 followerText[64];
        resetContactOutbox();
        // Slot 36's optional costume bank has broken casting frames in this quest.
        // Keep the sword's weapon art, damage and abilities; use the complete hero bank.
        itemdata masterSword=Game->LoadItemData(36);masterSword->TileMod=0;
        int stages[3];int selectedPlot=0;
        int plotXs[]={24,56,88};int plotY=88;int plotX=plotXs[0];int plotCenterX=plotX+8;int plotCenterY=plotY+8;int plotFootY=plotY+16;bool farmSpawned=false;bool clearingReady=false;
        int welcome = 0;
        int tutorialContext=0;int tutorialAck=0;

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
        bool accountMode=false;int accountCount=0;int accountDMap=4;int accountScreen=63;int accountX[16];int accountY[16];int accountDirection[16];char32 accountText[512];
        char32 line[128];
        // Presentation-only bridge. A stale or absent browser lease restores
        // native text; no browser HUD value authorizes a gameplay action.
        int presentationLease=0;int presentationLeaseTick=-120;
        int presentationTask=0;char32 presentationText[192];
        printf("CHARMVILLE_HOMESTEAD_ACTIVE\n");
        while (true)
        {
            ticks++;
            presentationTask=0;
            if(ticks%15==0){
                file uiLease=new file("/charmville/presentation-ui-lease.txt","r");
                if(uiLease->isValid()){
                    presentationText[0]=0;uiLease->ReadString(presentationText);uiLease->Close();
                    int nextLease=field(presentationText,0);
                    if(nextLease>0 && nextLease!=presentationLease){presentationLease=nextLease;presentationLeaseTick=ticks;}
                }
            }
            bool presentationAlive=presentationLease>0 && ticks-presentationLeaseTick<120;
            if(ticks==1 || ticks%30==0)publishEquipment();
            if(ticks%60==0){
                file movementMode=new file("/charmville/movement-mode.txt","w");
                if(movementMode->isValid()){
                    sprintf(line,"New %d / New2 %d / LTTP %d / Diagonal %d / Step %d",Game->FFRules[qr_NEW_HERO_MOVEMENT],Game->FFRules[qr_NEW_HERO_MOVEMENT2],Game->FFRules[qr_LTTPWALK],Hero->Diagonal,Hero->Step);
                    movementMode->WriteString(line);movementMode->Close();
                }
            }
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
            if(ticks==1 || ticks%2==0){
                file peers=new file("/charmville/account-peers.txt","r");
                if(peers->isValid()){
                    accountText[0]=0;peers->ReadString(accountText);peers->Close();
                    if(field(accountText,0)==1){int count=Min(16,Max(0,field(accountText,1)));if(!accountMode || count!=accountCount)printf("CHARMVILLE_ACCOUNT_PEERS %d\n",count);accountMode=true;accountCount=count;accountDMap=field(accountText,2+count*3);accountScreen=field(accountText,3+count*3);for(int p=0;p<16;p++)life[p]=0;
                        for(int p=0;p<accountCount;p++){accountX[p]=field(accountText,2+p*2);accountY[p]=field(accountText,3+p*2);int dir=field(accountText,2+accountCount*2+p);if(dir<0 || dir>3)dir=DIR_DOWN;if(dir!=accountDirection[p])printf("CHARMVILLE_PEER_FACING %d DIR %d\n",p,dir);accountDirection[p]=dir;}
                    }
                }
            }
            if(ticks%6==0 && Hero->Action!=LA_SCROLLING){
                file correction=new file("/charmville/position-correction.txt","r");
                if(correction->isValid()){
                    line[0]=0;correction->ReadString(line);correction->Close();
                    int request=field(line,0);int map=field(line,1);int screen=field(line,2);int x=field(line,3);int y=field(line,4);int facing=field(line,5);
                    if(request>lastCorrection){
                        bool validPlacement=map==4 && (screen==62 || screen==63) && x>=0 && x<=240 && y>=0 && y<=160 && x%8==0 && y%8==0 && facing>=0 && facing<=3;
                        // Explicit account admission can return from a reference-only screen.
                        // Leave the receipt pending until the destination is loaded and placed.
                        if(validPlacement && !loadedRoom(map,screen) && Hero->Z==0 && Hero->FakeZ==0){
                            Hero->Warp(map,screen);
                        }
                        if(validPlacement && loadedRoom(map,screen) && Hero->Z==0 && Hero->FakeZ==0){
                            // Corrections carry source-room-local pixels. Apply
                            // the loaded region offset once, after any warp.
                            int origin=Game->GetCurScreen();
                            x+=(screen%16-origin%16)*256;
                            y+=(Floor(screen/16)-Floor(origin/16))*176;
                            if(resourceMode && activity>=0 && lifecycleStarted && !contactSent){lifecycleSequence++;publishLifecycle(lifecycleSequence,localActionId,2,activity,selectedPlot);}
                            activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;Hero->X=x;Hero->Y=y;if(field(line,6)!=1)Hero->Dir=facing;
                            trailCount=0;trailHead=0;lastHeroX=x;lastHeroY=y;farmSpawned=true;
                            // A deferred airborne placement must remain retryable.
                            lastCorrection=request;appliedCorrection=request;
                            printf("CHARMVILLE_POSITION_CORRECTED %d X %d Y %d\n",request,x,y);
                        }
                    }
                }
            }
            if(Hero->Action!=LA_SCROLLING){
                file position=new file("/charmville/position.txt","w");
                if(position->isValid()){
                    positionSequence++;
                    // Append source map and rectangle dimensions. Hero X/Y are
                    // region-local; CurScreen identifies the rectangle origin.
                    // The browser boundary derives the containing source room.
                    sprintf(line,"%d|%d|%d|%f|%f|%d|%f|%f|%d|%d|%d|%d",positionSequence,Game->GetCurDMap(),Game->GetCurScreen(),Hero->X,Hero->Y,Hero->Dir,Hero->Z,Hero->FakeZ,appliedCorrection,Game->GetCurMap(),Max(1,Region->ScreenWidth),Max(1,Region->ScreenHeight));
                    position->WriteString(line);position->Close();
                    // Retain one second of actual native frames for a delayed
                    // browser observer. Never reconstruct unobserved corners.
                    char32 historyPath[64];sprintf(historyPath,"/charmville/position-%d.txt",positionSequence%64);
                    file history=new file(historyPath,"w");
                    if(history->isValid()){history->WriteString(line);history->Close();}
                }
            }
            if(ticks==60){matchPalette(dirt,berry_dirt_colors);matchPalette(sprout,berry_sprout_colors);matchPalette(berry,berry_oran_colors);matchPalette(hoeFG,hoe_fg_colors);matchPalette(hoeBG,hoe_bg_colors);matchPalette(waterFG,water_fg_colors);matchPalette(waterBG,water_bg_colors);matchPalette(hair,gold_hair_colors);matchPalette(treecko,follower_treecko_colors);matchPalette(torchic,follower_torchic_colors);matchPalette(mudkip,follower_mudkip_colors);matchPalette(pikachu,follower_pikachu_colors);matchPalette(eevee,follower_eevee_colors);matchPalette(poochyena,follower_poochyena_colors);matchPalette(attackTreecko,attack_treecko_colors);matchPalette(attackTorchic,attack_torchic_colors);matchPalette(attackMudkip,attack_mudkip_colors);matchPalette(attackPikachu,attack_pikachu_colors);matchPalette(attackEevee,attack_eevee_colors);matchPalette(attackPoochyena,attack_poochyena_colors);matchPalette(captureBall,capture_ball_colors);matchPalette(faintPoochyena,faint_poochyena_colors);printf("CHARMVILLE_PRESENTATION_READY\n");}
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
                int relayScreen=Game->HeroScreen;
                sprintf(line,"world|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d",sequence,Hero->X-Region->WorldOffsetX(relayScreen),Hero->Y-Region->WorldOffsetY(relayScreen),Hero->Tile,Hero->CSet,Hero->Flip,Game->GetCurDMap(),relayScreen,harvests>0?1:0,aura?1:0);
                channel->Send(line);
                sequence++;
                while(channel->HasMessage)
                {
                    char32[] reply=channel->Receive();
                    int id=field(reply,1);
                    int peerScreen=field(reply,9);int peerX=field(reply,2);int peerY=field(reply,3);
                    if(id>=0 && id<16){
                        if(loadedRoom(field(reply,8),peerScreen) && peerX>=0 && peerX<256 && peerY>=0 && peerY<176){px[id]=peerX+Region->WorldOffsetX(peerScreen);py[id]=peerY+Region->WorldOffsetY(peerScreen);pt[id]=field(reply,4);pc[id]=field(reply,5);pf[id]=field(reply,6);pa[id]=field(reply,7);life[id]=120;}
                        else life[id]=0;
                    }
                }
            }
            Screen->DrawOrigin=DRAW_ORIGIN_REGION;
            if(!accountMode)for(int p=0;p<16;p++)if(life[p]>0){life[p]--;if(pa[p])drawAura(px[p],py[p],ticks);Screen->DrawTile(behindHeroLayer(),px[p],py[p],pt[p],1,1,pc[p],-1,-1,0,0,0,pf[p]);}
            // Account transport retains server-filtered, single-room interest.
            // The batch's source room is translated only when actually loaded.
            if(accountMode && loadedRoom(accountDMap,accountScreen))for(int p=0;p<accountCount;p++){
                int peerX=accountX[p]+Region->WorldOffsetX(accountScreen);int peerY=accountY[p]+Region->WorldOffsetY(accountScreen);
                // Pinned offline quest probe: left/right share tile20; left flips1.
                // Do not query unsupported GetOriginalFlip or reuse local facing.
                Screen->DrawTile(peerY<Hero->Y?behindHeroLayer():6,peerX,peerY,Hero->GetOriginalTile(0,accountDirection[p])+Hero->TileMod,1,1,Hero->CSet,-1,-1,0,0,0,accountDirection[p]==DIR_LEFT?1:0);
            }
            Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            if (Input->KeyPress[KEY_T] || Hero->PressEx4)
            {
                aura = !aura;
                printf("CHARMVILLE_AURA %d\n", aura);
            }
            if (aura)
            {
                // Native prototype effect; not imported DBZ animation frames.
                // Body-attached effects follow visual elevation. Ground position
                // remains unchanged for collision, crops and account movement.
                int auraBodyY=Hero->Y-Hero->Z-Hero->FakeZ;
                Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                drawAura(Hero->X,auraBodyY,ticks);
                int hairRow=Hero->Dir==DIR_UP?8:(Hero->Dir==DIR_LEFT?9:(Hero->Dir==DIR_DOWN?10:11));
                // LPC reserves column zero for idle; its walk cycle is 1..8.
                int hairFrame=Hero->Action==LA_WALKING?1+Floor(ticks/8)%8:0;
                hair->Blit(6,RT_CURRENT,hairFrame*64,hairRow*64,64,64,Hero->X-8,auraBodyY-9,32,32); Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            }
            if (loadedRoom(4,63))
            {
                bool farmHere=Game->HeroScreen==63;
                // Script layer 2 inherits the region origin's background flag,
                // even for meadow pixels. In that case terrain covers the draw;
                // layer 1 is the stable post-terrain, pre-actor pass.
                int farmGroundLayer=IsBackgroundLayer(2)?1:2;
                int farmOffsetX=Region->WorldOffsetX(63);int farmOffsetY=Region->WorldOffsetY(63);
                for(int bed=0;bed<3;bed++)plotXs[bed]=farmOffsetX+24+bed*32;
                plotY=farmOffsetY+88;plotCenterY=plotY+8;plotFootY=plotY+16;
                if(!clearingReady){
                    // Explicit single-room temporary pointers keep local combo
                    // indices on meadow 63, even when west 62 is the origin.
                    // Copy the same clear column on every active meadow layer.
                    mapdata meadow=Game->LoadTempScreen(0,63);
                    int solid=0;bool prepared=true;if(!meadow)prepared=false;
                    for(int layer=0;layer<=6;layer++){
                        if(!meadow)break;
                        if(layer>0 && meadow->LayerMap[layer]<=0)continue;
                        mapdata groundLayer=Game->LoadTempScreen(layer,63);
                        if(!groundLayer){prepared=false;continue;}
                        int ground=groundLayer->ComboD[105];int cset=groundLayer->ComboC[105];
                        for(int row=4;row<=6;row++)for(int col=1;col<=6;col++){
                            int cell=row*16+col;groundLayer->ComboD[cell]=ground;groundLayer->ComboC[cell]=cset;groundLayer->ComboF[cell]=0;
                            solid+=groundLayer->ComboS[cell];
                        }
                    }
                    clearingReady=prepared;if(prepared){printf("CHARMVILLE_FARM_CLEARING READY SOLID %d\n",solid);printf("CHARMVILLE_FARM_GROUND_LAYER %d ORIGIN %d BG2 %d MEADOW_BG2 %d\n",farmGroundLayer,Game->GetCurScreen(),IsBackgroundLayer(2)?1:0,IsBackgroundLayer(2,meadow)?1:0);}
                }
                if(!farmSpawned && farmHere && clearingReady){Hero->X=farmOffsetX+16;Hero->Y=farmOffsetY+72;Hero->Dir=DIR_DOWN;farmSpawned=true;}
                if(activity<0 && farmHere){
                    int nearest=100000;for(int bed=0;bed<3;bed++){int dx=plotXs[bed]+8-(Hero->X+8);int dy=plotY+8-(Hero->Y+8);int distance=dx*dx+dy*dy;if(distance<nearest){nearest=distance;selectedPlot=bed;}}
                }
                plotX=plotXs[selectedPlot];plotCenterX=plotX+8;
                Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                // Browser-proven RT_CURRENT addresses the current layer's draw
                // buffer. RT_SCREEN loses low-layer bitmap draws in this runtime.
                for(int bed=0;bed<3;bed++){
                    dirt->Blit(farmGroundLayer,RT_CURRENT,0,0,16,16,plotXs[bed],plotY,16,16);
                }
                Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;

                // Presentation-only requests: context + sequence + expected page.
                // No synthetic combat input and no reward authority.
                file preference=new file("/charmville/tutorial-state.txt","r");
                if(preference->isValid()){
                    line[0]=0;preference->ReadString(line);preference->Close();
                    int context=field(line,1);
                    if(context!=tutorialContext){tutorialContext=context;tutorialAck=0;welcome=0;}
                    if(field(line,0)==1)welcome=2;
                }
                bool tutorialAdvance=false;
                file request=new file("/charmville/tutorial-request.txt","r");
                if(request->isValid()){
                    line[0]=0;request->ReadString(line);request->Close();
                    int sequence=field(line,1);
                    if(field(line,0)==tutorialContext && sequence>tutorialAck){
                        tutorialAck=sequence;tutorialAdvance=field(line,2)==welcome;
                    }
                }
                file progress=new file("/charmville/tutorial-progress.txt","w");
                if(progress->isValid()){sprintf(line,"%d|%d|%d",tutorialContext,welcome,tutorialAck);progress->WriteString(line);progress->Close();}
                if(welcome<2 && farmHere)
                {
                    Hero->InputUp=false;Hero->InputDown=false;Hero->InputLeft=false;Hero->InputRight=false;
                    Hero->InputAxisUp=false;Hero->InputAxisDown=false;Hero->InputAxisLeft=false;Hero->InputAxisRight=false;
                    Hero->InputA=false;Hero->InputB=false;Hero->PressA=false;Hero->PressB=false;
                    Screen->DrawOrigin=DRAW_ORIGIN_PLAYING_FIELD;
                    Screen->Rectangle(6,0,128,255,175,0);
                    if(welcome==0){
                        sprintf(line,"Welcome to the meadow!");Screen->DrawString(6,4,130,0,1,-1,0,line);
                        sprintf(line,"Start small. Grow together.");Screen->DrawString(6,4,141,0,1,-1,0,line);
                    }else{
                        sprintf(line,"Till, plant, water, harvest.");Screen->DrawString(6,4,130,0,1,-1,0,line);
                        if(resourceMode)sprintf(line,"Harvest Oran into your satchel.");else sprintf(line,"First crop opens guest play.");Screen->DrawString(6,4,141,0,1,-1,0,line);
                    }
                    sprintf(line,"E / D / Interact: continue");Screen->DrawString(6,4,160,0,1,-1,0,line);
                    if(tutorialAdvance || Input->KeyPress[KEY_E] || Hero->PressEx3){
                        welcome++;
                        if(welcome==2){file completed=new file("/charmville/tutorial-completed.txt","w");if(completed->isValid()){sprintf(line,"1");completed->WriteString(line);completed->Close();}}
                    }
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                    if(ticks%15==0){
                        file introUI=new file("/charmville/presentation-ui.txt","w");
                        if(introUI->isValid()){
                            sprintf(presentationText,"1|%d|0|%d|%d|%d|%d|%d|%d|%d|0|0|%d|1",welcome,selectedPlot+1,resourceMode?resourceProduce:berries,resourceMode?-1:harvests*10,cuttings,resourceMode?accountCount:0,resourceMode?1:0,resourceMode?resourceSeeds:-1,ticks);
                            introUI->WriteString(presentationText);introUI->Close();
                        }
                    }
                    Waitframe();continue;
                }
                int reachX=plotCenterX-(Hero->X+8);int reachY=plotCenterY-(Hero->Y+8);
                // One-tile tools must contact the selected bed, not work from
                // two tiles away or diagonally beyond the directional sprite.
                int requiredPermission=stages[selectedPlot]==4?8:(stages[selectedPlot]==2?4:(stages[selectedPlot]==1?2:1));
                bool permittedAction=!resourceMode || (resourcePermissions[selectedPlot]&requiredPermission)!=0;
                bool nearPlot = farmHere && clearingReady && reachX*reachX+reachY*reachY<=400 && Min(Abs(reachX),Abs(reachY))<=8;
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
                if(activity>=0 && (!farmHere || Hero->Z!=0 || Hero->FakeZ!=0 || Hero->HP<activityLife || Hero->X!=activityX || Hero->Y!=activityY || (Hero->Action!=LA_NONE && Hero->Action!=LA_WALKING)))
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
                    // 16px foot baseline in region pixels: 16 - 30 = -14.
                    if((activity==0 || activity==2) && frame!=lastToolFrame){printf("CHARMVILLE_TOOL %d DIR %d FRAME %d\n",activity,activityDir,frame);lastToolFrame=frame;}
                    int toolY=Hero->Y-14;
                    Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                    if(activity==0){hoeBG->Blit(1,RT_CURRENT,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);hoeFG->Blit(6,RT_CURRENT,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);}
                    if(activity==2){waterBG->Blit(1,RT_CURRENT,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);waterFG->Blit(6,RT_CURRENT,frame*64,row*64,64,64,Hero->X-8,toolY,32,32);}
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                    // No held prop until a crop item has its own validated sprite identity.
                    if(activity==2 && activityTick>=18 && activityTick<36){
                        Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                        int spoutX=activityX+8+(activityDir==DIR_LEFT?-8:(activityDir==DIR_RIGHT?8:0));
                        int spoutY=activityY+8+(activityDir==DIR_UP?-8:(activityDir==DIR_DOWN?8:0));
                        for(int drop=0;drop<4;drop++){
                            int phase=(activityTick+drop*4)%18;
                            Screen->Circle(6,spoutX+(plotCenterX-spoutX)*phase/18,spoutY+(plotCenterY-spoutY)*phase/18,1,0x91);
                        }
                        Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
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
                    int plantLayer=Hero->Y+16<plotFootY?6:farmGroundLayer;
                    Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                    if(stages[bed]==3){int age=resourceMode?resourcePhase[bed]*100:ticks-wateredTimes[bed];
                        if(age<100)sprout->Blit(farmGroundLayer,RT_CURRENT,(Floor(ticks/32)%2)*16,0,16,16,plotXs[bed],plotY,16,16);
                        else if(age<200)berry->Blit(plantLayer,RT_CURRENT,(Floor(ticks/48)%2)*16,0,16,32,plotXs[bed],plotY-16,16,32);
                        else berry->Blit(plantLayer,RT_CURRENT,32+(Floor(ticks/64)%2)*16,0,16,32,plotXs[bed],plotY-16,16,32);
                    }
                    if(stages[bed]==4)berry->Blit(plantLayer,RT_CURRENT,64+(Floor(ticks/96)%2)*16,0,16,32,plotXs[bed],plotY-16,16,32);
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                }
                if(farmHere){
                presentationTask=stages[selectedPlot]+1;
                if(stages[selectedPlot]==3){
                    int phase=resourceMode?resourcePhase[selectedPlot]:Min(2,Floor((ticks-wateredTimes[selectedPlot])/100));
                    presentationTask=4+phase;
                }
                if(stages[selectedPlot]==4)presentationTask=7;
                if(resourceMode && resourceReady && !permittedAction && stages[selectedPlot]!=3)presentationTask=8;
                if(activity<0 && !nearPlot && (presentationTask==1 || presentationTask==2 || presentationTask==3 || presentationTask==7))presentationTask=12;
                if(resourceMode && !resourceReady)presentationTask=9;
                else if(resourceMode && pendingReceipt)presentationTask=10;
                else if(resourceMode && activity>=0 && authorization<0)presentationTask=11;
                if(!presentationAlive){
                Screen->DrawOrigin=DRAW_ORIGIN_PLAYING_FIELD;
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
                if(presentationTask==12)sprintf(line,"Move closer to this bed");
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
                Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                }
                }
            }
            if(ticks%15==0){
                int uiGuests=0;for(int p=0;p<16;p++)if(life[p]>0)uiGuests++;
                if(resourceMode)uiGuests=accountCount;
                file uiState=new file("/charmville/presentation-ui.txt","w");
                if(uiState->isValid()){
                    sprintf(presentationText,"1|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d",welcome,presentationTask,selectedPlot+1,resourceMode?resourceProduce:berries,resourceMode?-1:harvests*10,cuttings,uiGuests,resourceMode?1:0,resourceMode?resourceSeeds:-1,fed[selectedPlot]?1:0,(!resourceMode && stages[selectedPlot]==3 && !fed[selectedPlot] && cuttings>0)?1:0,ticks,presentationTask>0?1:0);
                    uiState->WriteString(presentationText);uiState->Close();
                }
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
            // Internal region seams leave CurScreen and region-world trail
            // coordinates stable. LA_SCROLLING is a real region transition;
            // its temporary coordinates must never enter the walked history.
            if(Hero->Action==LA_SCROLLING){
                followerScrolling=true;trailCount=0;trailHead=0;
                lastHeroX=Hero->X;lastHeroY=Hero->Y;
                for(int member=0;member<6;member++)followerVisible[member]=false;
            }else{
            // Reset even if the engine finished a scroll without changing the
            // reported screen id. Do not record its final placement as movement.
            if(followerScrolling){
                followerScrolling=false;trailCount=0;trailHead=0;
                lastHeroX=Hero->X;lastHeroY=Hero->Y;
            }
            int stepX=Hero->X-lastHeroX;int stepY=Hero->Y-lastHeroY;
            if(Abs(stepX)>24 || Abs(stepY)>24){trailCount=0;trailHead=0;}
            else if(stepX!=0 || stepY!=0){
                trailX[trailHead]=Hero->X;trailY[trailHead]=Hero->Y;trailDir[trailHead]=Hero->Dir;
                trailHead=(trailHead+1)%512;trailCount=Min(trailCount+1,512);followerClock++;
            }
            lastHeroX=Hero->X;lastHeroY=Hero->Y;
            // At spawn there is no walked history. Seed a short connected,
            // collision-tested presentation path instead of hiding the party.
            // Later entries are exclusively the hero's actual visited positions.
            if(trailCount==0){
                int seedX[16];int seedY[16];int seedDir[16];int count=1;
                seedX[0]=Hero->X;seedY[0]=Hero->Y;seedDir[0]=Hero->Dir;
                for(int n=1;n<16;n++){
                    bool found=false;
                    for(int turn=0;turn<4 && !found;turn++){
                        // Seed behind the arriving farmer before spreading out.
                        // Walked history later retains its actual route unchanged.
                        int dir=DIR_UP;
                        if(turn==1)dir=DIR_LEFT;if(turn==2)dir=DIR_RIGHT;if(turn==3)dir=DIR_DOWN;
                        int dx=dir==DIR_RIGHT?16:(dir==DIR_LEFT?-16:0);
                        int dy=dir==DIR_DOWN?16:(dir==DIR_UP?-16:0);
                        int x=seedX[n-1]+dx;int y=seedY[n-1]+dy;bool clear=true;
                        // Reserve the beds plus the companions' sprite overhang.
                        // This is initial presentation placement, not new terrain:
                        // followers may still follow real footsteps through here.
                        if(loadedRoom(4,63))for(int bed=0;bed<3;bed++)
                            if(x-8<plotXs[bed]+16 && x+24>plotXs[bed] && y-24<plotY+16 && y+24>plotY)clear=false;
                        for(int k=0;k<n;k++)if(seedX[k]==x && seedY[k]==y)clear=false;
                        if(clear && followerSegment(seedX[n-1],seedY[n-1],x,y)){
                            seedX[n]=x;seedY[n]=y;seedDir[n]=dir;count++;found=true;
                        }
                    }
                    if(!found)break;
                }
                for(int n=count-1;n>=0;n--){trailX[trailHead]=seedX[n];trailY[trailHead]=seedY[n];trailDir[trailHead]=seedDir[n]^1;trailHead=(trailHead+1)%512;trailCount++;}
                printf("CHARMVILLE_FOLLOWER_SPAWN_PATH %d\n",count);
            }
            // Fit only active walkers into the connected trail. A short arrival
            // path can compress the preferred spacing, but never below a 16px
            // ground footprint. Slots that do not fit remain honestly hidden.
            int activeWalkers=0;int availableTrail=0;int previousX=Hero->X;int previousY=Hero->Y;
            int followerDirection[6];int activeRank=0;
            for(int member=0;member<6;member++){followerVisible[member]=false;if(partyFollowers[member]>0)activeWalkers++;}
            for(int age=0;age<trailCount && availableTrail<followerSpacing*activeWalkers;age++){
                int trail=(trailHead+511-age)%512;
                if(!followerSegment(previousX,previousY,trailX[trail],trailY[trail]))break;
                int dx=trailX[trail]-previousX;int dy=trailY[trail]-previousY;
                availableTrail+=Sqrt(dx*dx+dy*dy);previousX=trailX[trail];previousY=trailY[trail];
            }
            int fittedSpacing=activeWalkers>0?Max(16,Min(followerSpacing,availableTrail/activeWalkers)):followerSpacing;
            // New history must not snap the last walker outward by six times
            // the spacing change. ZScript numeric values support fractions.
            // Expand at most 1.5 world pixels/frame at the sixth party position.
            resolvedFollowerSpacing=Min(fittedSpacing,resolvedFollowerSpacing+0.25);
            for(int member=0;member<6;member++){
            follower=partyFollowers[member];if(follower==0)continue;activeRank++;
            int followerGap=resolvedFollowerSpacing*activeRank;int walked=0;int fx=Hero->X;int fy=Hero->Y;int direction=Hero->Dir;bool trailReady=false;
            if(followerGap<=availableTrail){
            for(int age=0;age<trailCount;age++){
                int trail=(trailHead+511-age)%512;
                int dx=trailX[trail]-fx;int dy=trailY[trail]-fy;
                int length=Sqrt(dx*dx+dy*dy);
                if(length>0 && walked+length>=followerGap){
                    int fraction=(followerGap-walked)/length;
                    fx+=dx*fraction;fy+=dy*fraction;
                    // Face toward the newer trail point, including seeded bends.
                    direction=Abs(dx)>Abs(dy)?(dx>0?DIR_LEFT:DIR_RIGHT):(dy>0?DIR_UP:DIR_DOWN);
                    trailReady=true;break;
                }
                walked+=length;fx=trailX[trail];fy=trailY[trail];direction=trailDir[trail];
            }
            }
            // Followers are visual actors, not solid terrain. At a corner,
            // separated points along the trail can briefly overlap in screen
            // space. Keep drawing through that overlap; hiding here caused a
            // visible blink on ordinary turns and reversals. Terrain remains
            // collision-tested, and the normal depth layers resolve overlap.
            if(trailReady && !followerSpace(fx,fy))trailReady=false;
            followerX[member]=fx;followerY[member]=fy;followerVisible[member]=follower>0 && trailReady;
            followerDirection[member]=direction;
            }
            // Preserve back-to-front party drawing after forward placement.
            for(int member=5;member>=0;member--){
            follower=partyFollowers[member];bool trailReady=followerVisible[member];
            int fx=followerX[member];int fy=followerY[member];int direction=followerDirection[member];
            if(follower>0 && trailReady && !(member==attackSlot && attackClock>=0 && attackClock<attackTotal)){
                if(lastFollowerDraw[member]!=follower){printf("CHARMVILLE_FOLLOWER_DRAW %d\n",follower);printf("CHARMVILLE_PARTY_DRAW %d %d\n",member,follower);lastFollowerDraw[member]=follower;}
                // PMD source rows: S,SE,E,NE,N,NW,W,SW. Draw unchanged walking frames.
                int row=direction==DIR_UP?4:(direction==DIR_LEFT?6:(direction==DIR_DOWN?0:2));
                int layer=fy+16<Hero->Y+16?behindHeroLayer():6;
                Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                // Region sprite coordinates include camera and playing-field offset.
                if(follower==25){int phase=(stepX==0 && stepY==0)?0:followerClock%36;int frame=phase<8?0:(phase<18?1:(phase<26?2:(3)));int anchor=row*4+frame;drawCompanionScaled(pikachu,25,layer,frame*32,row*40,32,40,fx+8,fy+16,pikachuAnchorX[anchor],pikachuAnchorY[anchor]);}
if(follower==133){int phase=(stepX==0 && stepY==0)?0:followerClock%26;int frame=phase<4?0:(phase<8?1:(phase<12?2:(phase<16?3:(phase<22?4:(phase<24?5:(6))))));int anchor=row*7+frame;drawCompanionScaled(eevee,133,layer,frame*40,row*48,40,48,fx+8,fy+16,eeveeAnchorX[anchor],eeveeAnchorY[anchor]);}
if(follower==286){int phase=(stepX==0 && stepY==0)?0:followerClock%20;int frame=phase<4?0:(phase<8?1:(phase<12?2:(phase<16?3:(4))));int anchor=row*5+frame;drawCompanionScaled(poochyena,286,layer,frame*32,row*48,32,48,fx+8,fy+16,poochyenaAnchorX[anchor],poochyenaAnchorY[anchor]);}
                if(follower==277){int phase=(stepX==0 && stepY==0)?0:followerClock%32;int frame=phase<6?0:(phase<16?1:(phase<22?2:3));drawCompanionScaled(treecko,277,layer,frame*32,row*32,32,32,fx+8,fy+16,16,20);}
                if(follower==280){int frame=(stepX==0 && stepY==0)?0:Floor(followerClock/8)%4;drawCompanionScaled(torchic,280,layer,frame*24,row*32,24,32,fx+8,fy+16,12,20);}
                if(follower==283){int phase=(stepX==0 && stepY==0)?0:followerClock%30;int frame=phase<4?0:(phase<10?1:(phase<14?2:(phase<20?3:(phase<26?4:5))));int anchor=row*6+frame;drawCompanionScaled(mudkip,283,layer,frame*32,row*40,32,40,fx+8,fy+16,mudkipAnchorX[anchor],mudkipAnchorY[anchor]);}
                Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            }
            }
            }
            // Wire receipts remain meadow-local. Derive region anchors without
            // changing stored receipt coordinates when the camera or origin moves.
            bool encounterRoomLoaded=loadedRoom(4,63);
            int encounterOffsetX=encounterRoomLoaded?Region->WorldOffsetX(63):0;
            int encounterOffsetY=encounterRoomLoaded?Region->WorldOffsetY(63):0;
            if(ticks%6==0){
                file encounterFile=new file("/charmville/world-encounter.txt","r");
                if(encounterFile->isValid()){
                    encounterText[0]=0;encounterFile->ReadString(encounterText);encounterFile->Close();
                    int version=field(encounterText,0);
                    int generation=field(encounterText,12);
                    if(version!=encounterVersion || generation!=encounterGeneration){bool changedIdentity=generation!=encounterGeneration;int previousHP=encounterHP;int previousVisible=changedIdentity?0:encounterVisible;bool established=encounterVersion>0 && !changedIdentity;if(changedIdentity){encounterGeneration=generation;attackClock=-1;attackSlot=-1;attackTotal=0;attackJustStarted=false;encounterFlash=0;encounterDamage=0;faintClock=-1;defeatPending=false;encounterEffect=field(encounterText,6);attackAcknowledged=encounterEffect;printf("CHARMVILLE_ENCOUNTER_IDENTITY %d\n",generation);}encounterVersion=version;encounterVisible=field(encounterText,1);encounterX=field(encounterText,2)*8;encounterY=field(encounterText,3)*8;encounterHP=field(encounterText,4);encounterMaxHP=Max(1,field(encounterText,5));
                        int effect=field(encounterText,6);if(established && effect>encounterEffect){encounterFlash=30;encounterDamage=field(encounterText,7);attackSpecies=field(encounterText,8);attackX=field(encounterText,9)*8+encounterOffsetX;attackY=field(encounterText,10)*8+encounterOffsetY;attackSlot=field(encounterText,11)-1;if(attackSlot>=0 && attackSlot<6 && followerVisible[attackSlot] && partyFollowers[attackSlot]==attackSpecies){attackX=followerX[attackSlot];attackY=followerY[attackSlot];}else attackSlot=-1;attackClock=0;attackJustStarted=true;attackTotal=attackSpecies==277?19:(attackSpecies==280?28:(attackSpecies==283?24:(attackSpecies==25?21:(attackSpecies==133?30:(attackSpecies==286?24:0)))));attackHit=attackSpecies==277?8:(attackSpecies==280?14:(attackSpecies==25?7:(attackSpecies==133?8:10)));if(attackTotal>0)encounterFlash=0;int dx=encounterX+encounterOffsetX-attackX;int dy=encounterY+encounterOffsetY-attackY;attackRow=Abs(dx)>Abs(dy)?(dx<0?6:2):(dy<0?4:0);if(dx!=0 && dy!=0 && Abs(dx)*2>=Abs(dy) && Abs(dy)*2>=Abs(dx))attackRow=dy>0?(dx>0?1:7):(dx>0?3:5);printf("CHARMVILLE_ENCOUNTER_EFFECT %d DAMAGE %d\n",effect,encounterDamage);}encounterEffect=effect;
                        if(encounterVisible!=1 || encounterHP>0){faintClock=-1;defeatPending=false;}else if(previousVisible==1 && previousHP>0)defeatPending=true;
                        if(defeatPending && field(encounterText,13)==0){defeatPending=false;faintClock=0;printf("CHARMVILLE_DEFEAT_START\n");}
                        printf("CHARMVILLE_ENCOUNTER_STATE %d HP %d/%d\n",encounterVisible,encounterHP,encounterMaxHP);
                    }
                }
            }
            if(ticks%3==0){file captureFile=new file("/charmville/capture-event.txt","r");if(captureFile->isValid()){captureText[0]=0;captureFile->ReadString(captureText);captureFile->Close();int next=field(captureText,0);if(next!=captureSeq){captureSeq=next;captureClock=field(captureText,1)==1?0:-1;captureFromX=field(captureText,2)*8;captureFromY=field(captureText,3)*8;captureToX=field(captureText,4)*8;captureToY=field(captureText,5)*8;captureWon=field(captureText,6);captureShakes=field(captureText,7);printf("CHARMVILLE_CAPTURE_START %d RESULT %d SHAKES %d\n",captureSeq,captureWon,captureShakes);}}}
            int encounterRegionX=encounterX+encounterOffsetX;
            int encounterRegionY=encounterY+encounterOffsetY;
            int captureRegionFromX=captureFromX+encounterOffsetX;
            int captureRegionFromY=captureFromY+encounterOffsetY;
            int captureRegionToX=captureToX+encounterOffsetX;
            int captureRegionToY=captureToY+encounterOffsetY;
            if(!encounterRoomLoaded){faintClock=-1;defeatPending=false;}
            if(encounterVisible==1 && !(captureClock>=34 && captureClock<64+captureShakes*24) && encounterRoomLoaded){
                Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                if(encounterHP>0 || defeatPending)drawCompanionScaled(poochyena,286,encounterRegionY<Hero->Y?behindHeroLayer():6,0,0,32,48,encounterRegionX+8,encounterRegionY+16,poochyenaAnchorX[0],poochyenaAnchorY[0]);
                // Generated attack/faint helpers include 56px HUD space; remove it here.
                else {if(faintClock>=0 && faintClock<52){drawFaintPoochyena(faintPoochyena,Min(faintClock,33),0,encounterRegionX,encounterRegionY-56,encounterRegionY<Hero->Y?behindHeroLayer():6);faintClock++;if(faintClock==52)printf("CHARMVILLE_DEFEAT_COMPLETE\n");}sprintf(encounterText,"Defeated");Screen->DrawString(6,encounterRegionX-16,encounterRegionY-24,0,0x01,-1,0,encounterText);}
                Screen->Rectangle(6,encounterRegionX-2,encounterRegionY-12,encounterRegionX+18,encounterRegionY-9,0x00);
                if(encounterHP>0)Screen->Rectangle(6,encounterRegionX-1,encounterRegionY-11,encounterRegionX-1+18*encounterHP/encounterMaxHP,encounterRegionY-10,0x91);
                if(encounterFlash>0){sprintf(encounterText,"-%d",encounterDamage);Screen->DrawString(6,encounterRegionX,encounterRegionY-24-(30-encounterFlash)/3,0,0x01,-1,0,encounterText);}
            }
            Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            // Cancel departed-region playback while still acknowledging accepted effects.
            if(!encounterRoomLoaded || encounterVisible!=1){attackClock=attackTotal;attackSlot=-1;}
            if(!attackJustStarted && attackClock>=0 && attackClock<attackTotal && encounterVisible==1 && encounterRoomLoaded){
                // Keep accepted clocks progressing during a real room scroll.
                // Region rendering applies the moving viewport exactly once.
                if(Hero->Action!=LA_SCROLLING){
                Screen->DrawOrigin=DRAW_ORIGIN_REGION;int layer=attackY<Hero->Y?behindHeroLayer():6;
                if(attackSpecies==277)drawAttack_treecko(attackTreecko,attackClock,attackRow,attackX,attackY-56,layer);
                if(attackSpecies==280)drawAttack_torchic(attackTorchic,attackClock,attackRow,attackX,attackY-56,layer);
                if(attackSpecies==283)drawAttack_mudkip(attackMudkip,attackClock,attackRow,attackX,attackY-56,layer);
                if(attackSpecies==25)drawAttack_pikachu(attackPikachu,attackClock,attackRow,attackX,attackY-56,layer);
                if(attackSpecies==133)drawAttack_eevee(attackEevee,attackClock,attackRow,attackX,attackY-56,layer);
                if(attackSpecies==286)drawAttack_poochyena(attackPoochyena,attackClock,attackRow,attackX,attackY-56,layer);

                Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                }
                if(attackClock==attackHit){encounterFlash=30;printf("CHARMVILLE_ATTACK_CONTACT %d ROW %d\n",attackSpecies,attackRow);}
                attackClock++;
            }
            if(encounterEffect>attackAcknowledged && (attackClock>=attackTotal || attackTotal==0)){
                file ack=new file("/charmville/encounter-effect-ack.txt","w");if(ack->isValid()){sprintf(encounterText,"%d",encounterEffect);ack->WriteString(encounterText);ack->Close();attackAcknowledged=encounterEffect;}
            }
            if(captureClock>=0){
                int end=64+captureShakes*24;int total=end+30;
                if(!encounterRoomLoaded)captureClock=total;
                if(captureClock<total){
                    Screen->DrawOrigin=DRAW_ORIGIN_REGION;
                    if(captureWon==1 && captureClock<34 && encounterVisible!=1)drawCompanionScaled(poochyena,286,captureRegionToY<Hero->Y?behindHeroLayer():6,0,0,32,48,captureRegionToX+8,captureRegionToY+16,poochyenaAnchorX[0],poochyenaAnchorY[0]);
                    int bx=captureRegionToX;int by=captureRegionToY;int frame=0;
                    if(captureClock<24){int t=captureClock/24;bx=captureRegionFromX+(captureRegionToX-captureRegionFromX)*t;by=captureRegionFromY+(captureRegionToY-captureRegionFromY)*t-40*t*(1-t);}
                    else if(captureClock<29)frame=1;else if(captureClock<39)frame=2;else if(captureClock<44)frame=1;
                    else if(captureClock>=64 && captureClock<end){int phase=(captureClock-64)%24;if(phase<6)bx-=2;else if(phase<12)bx+=2;}
                    else if(captureClock>=end && captureWon==0)frame=2;
                    captureBall->Blit(6,RT_CURRENT,0,frame*16,16,16,bx,by,16,16);
                    if(captureClock==24)printf("CHARMVILLE_CAPTURE_OPEN %d\n",captureSeq);
                    if(captureClock==end)printf("CHARMVILLE_CAPTURE_RESULT %d WON %d\n",captureSeq,captureWon);
                    if(captureClock>=end){if(captureWon==1)sprintf(captureText,"Captured");else sprintf(captureText,"Broke free");Screen->DrawString(6,captureRegionToX,captureRegionToY-16,0,0x01,-1,0,captureText);}
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;captureClock++;
                }
                if(captureClock>=total){file ack=new file("/charmville/capture-ack.txt","w");if(ack->isValid()){sprintf(captureText,"%d",captureSeq);ack->WriteString(captureText);ack->Close();}captureClock=-1;}
            }
            attackJustStarted=false;
            if(encounterFlash>0)encounterFlash--;
            Waitframe();
        }
        Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
    }
}

