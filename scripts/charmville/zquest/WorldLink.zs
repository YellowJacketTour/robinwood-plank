#include "std.zh"

// Integration probe for ZQuest 3.0. Compile with the preserved native compiler.
// Attach to a test quest's generic script slot before expecting runtime traffic.
// Pose reports are untrusted presentation data, never ownership/mint authority.
generic script CharmvilleWorldLink
{
    void run()
    {
        websocket channel = new websocket("ws://localhost:3022");
        int sequence = 0;
        int tick = 0;
        char32 packet[256];
        while (true)
        {
            if (channel->State == WEBSOCKET_STATE_CLOSED)
            {
                printf("Charmville reference link closed; quest continues locally.\n");
                break;
            }
            if (channel->State == WEBSOCKET_STATE_OPEN)
            {
                if (tick % 6 == 0)
                {
                    sprintf(packet, "pose|%d|%d|%d|%d", sequence, Hero->X, Hero->Y, Hero->HP);
                    channel->Send(packet);
                    sequence++;
                }
                while (channel->HasMessage)
                {
                    // Receiving an acknowledgement does not alter local HP/items.
                    // Authoritative encounter/economy messages need a validated schema.
                    untyped[] reply = channel->Receive();
                    printf("Charmville reference acknowledgement: %s\n", reply);
                }
            }
            tick++;
            Waitframe();
        }
    }
}
