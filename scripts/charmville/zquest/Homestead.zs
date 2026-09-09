#include "std.zh"

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
    int field(char32[] text, int number)
    {
        int pos=0;
        while(number>0 && text[pos]!=0){if(text[pos]==124)number--;pos++;}
        return atoi(text,pos);
    }
    void run()
    {
        bitmap hoeFG=new bitmap(); bitmap hoeBG=new bitmap();
        bitmap waterFG=new bitmap(); bitmap waterBG=new bitmap(); bitmap hair=new bitmap();
        hoeFG->Read(0,"/charmville/hoe-fg.png");hoeBG->Read(0,"/charmville/hoe-bg.png");
        waterFG->Read(0,"/charmville/water-fg.png");waterBG->Read(0,"/charmville/water-bg.png");
        hair->Read(0,"/charmville/gold-hair.png");Waitframe();
        int stage = 0;
        int wateredAt = 0;
        int ticks = 0;
        int harvests = 0;
        bool aura = false;
        websocket channel = new websocket("ws://localhost:3022");
        int sequence = 0;
        int activity=-1;int activityTick=0;int activityDir=DIR_DOWN;
        int previousDMap=Game->GetCurDMap(); int previousScreen=Game->GetCurScreen();
        int px[16]; int py[16]; int pt[16]; int pc[16]; int pf[16]; int pa[16]; int life[16];
        char32 line[128];
        printf("CHARMVILLE_HOMESTEAD_ACTIVE\n");
        while (true)
        {
            ticks++;
            if(ticks==60){hoeFG->Read(0,"/charmville/hoe-fg.png");hoeBG->Read(0,"/charmville/hoe-bg.png");waterFG->Read(0,"/charmville/water-fg.png");waterBG->Read(0,"/charmville/water-bg.png");hair->Read(0,"/charmville/gold-hair.png");}
            if(channel->State==WEBSOCKET_STATE_CLOSED && ticks%180==0)channel=new websocket("ws://localhost:3022");
            if(previousDMap!=Game->GetCurDMap() || previousScreen!=Game->GetCurScreen())
            {
                for(int p=0;p<16;p++)life[p]=0;
                activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;
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
                int hairFrame=Hero->Action==LA_WALKING?(ticks/8)%8:0;
                Screen->DrawOrigin=DRAW_ORIGIN_SCREEN; hair->Blit(6,RT_SCREEN,hairFrame*64,hairRow*64,64,64,Hero->X-8,Hero->Y+47,32,32); Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
            }
            if (Game->GetCurDMap()==4 && Game->GetCurScreen()==63)
            {
                bool nearPlot = Abs(Hero->X-208)<32 && Abs(Hero->Y-80)<32;
                if ((Input->KeyPress[KEY_E] || Hero->PressEx3) && nearPlot && activity<0 && stage!=3 && (Hero->Action==LA_NONE || Hero->Action==LA_WALKING))
                {
                    activity=stage;activityTick=0;
                    int dx=216-(Hero->X+8);int dy=96-(Hero->Y+8);
                    activityDir=Abs(dx)>Abs(dy)?(dx<0?DIR_LEFT:DIR_RIGHT):(dy<0?DIR_UP:DIR_DOWN);
                }
                if(activity>=0)
                {
                    Hero->InputUp=false;Hero->InputDown=false;Hero->InputLeft=false;Hero->InputRight=false;
                    Hero->InputAxisUp=false;Hero->InputAxisDown=false;Hero->InputAxisLeft=false;Hero->InputAxisRight=false;
                    Hero->InputA=false;Hero->InputB=false;Hero->PressA=false;Hero->PressB=false;
                    Hero->Dir=activityDir;
                    int pose=activity==4?10:(activityTick<14?0:1);
                    Hero->ScriptTile=Hero->GetOriginalTile(pose,activityDir)+Hero->TileMod;
                    // Hosted player aborts on GetOriginalFlip; retain the native directional flip.
                    int row=activityDir==DIR_UP?4:(activityDir==DIR_LEFT?5:(activityDir==DIR_DOWN?6:7));
                    int frame=Min(activityTick/8,5);
                    Screen->DrawOrigin=DRAW_ORIGIN_SCREEN;
                    if(activity==0){hoeBG->Blit(1,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,Hero->Y+48,32,32);hoeFG->Blit(6,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,Hero->Y+48,32,32);}
                    if(activity==2){waterBG->Blit(1,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,Hero->Y+48,32,32);waterFG->Blit(6,RT_SCREEN,frame*64,row*64,64,64,Hero->X-8,Hero->Y+48,32,32);}
                    Screen->DrawOrigin=DRAW_ORIGIN_DEFAULT;
                    if(activity==1 || activity==4)Screen->DrawCombo(6,Hero->X,Hero->Y-(activity==4?12:0),Screen->ComboD[95],1,1,Screen->ComboC[95],activity==4?16:8,activity==4?16:8);
                    if(activity==2 && activityTick>=18 && activityTick<36)for(int drop=0;drop<4;drop++)Screen->Circle(6,210+drop*4,88+(activityTick+drop*3)%12,1,0x91);
                    if(activityTick==28)
                    {
                        if(activity==4){harvests++;stage=1;printf("CHARMVILLE_HARVEST %d XP %d\n",harvests,harvests*10);}
                        else{stage=activity+1;if(stage==3)wateredAt=ticks;}
                    }
                    activityTick++;
                    if(activityTick>=48){activity=-1;Hero->ScriptTile=-1;Hero->ScriptFlip=-1;}
                }
                if (stage==3 && ticks-wateredAt>=300) stage=4;
                // Plot states are visibly distinct; source crop-art adapter follows.
                if(stage>0)Screen->DrawCombo(1,208,88,Screen->ComboD[108],1,1,Screen->ComboC[108]);
                if(stage>=2){int size=stage==4?16:8;Screen->DrawCombo(2,208+(16-size)/2,88+(16-size)/2,Screen->ComboD[95],1,1,Screen->ComboC[95],size,size);}
                Screen->Rectangle(6,0,144,255,175,0x00);
                if (stage==0) sprintf(line,"Welcome! E / D: till nearby.");
                if (stage==1) sprintf(line,"E / D: plant. T / C: aura.");
                if (stage==2) sprintf(line,"E: water your seedling.");
                if (stage==3) sprintf(line,"Growing... Explore nearby.");
                if (stage==4) sprintf(line,"Ready! E / D: harvest.");
                Screen->DrawString(6,4,146,0,0x01,-1,0,line);
                sprintf(line,"Crop %d XP %d %s",harvests,harvests*10,harvests>0?(channel->State==WEBSOCKET_STATE_OPEN?"Guest meadow":"Meadow offline"):"Solo tutorial");
                Screen->DrawString(6,4,157,0,0x01,-1,0,line);
            }
            Waitframe();
        }
    }
}






