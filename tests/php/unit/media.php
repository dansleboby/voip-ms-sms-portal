<?php

// Downloads of the pictures and files received by MMS (server/vcard.test.ts, "media downloads").

declare(strict_types=1);

require __DIR__ . '/../harness.php';

use SmsPortal\Events;
use SmsPortal\Log;
use SmsPortal\Media;
use SmsPortal\Time;

/**
 * A web server that answers every request with $router, a PHP script run
 * in a folder of its own ($dir), for downloads that go over HTTP. It stops
 * when the test file ends.
 */
function serve(string $dir, string $router): string
{
    file_put_contents("$dir/router.php", $router);
    // A port nothing uses right now, picked by the system.
    $socket = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) substr((string) strrchr((string) stream_socket_get_name($socket, false), ':'), 1);
    fclose($socket);
    $null = ['file', '/dev/null', 'r+'];
    $server = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $dir, "$dir/router.php"], [$null, $null, $null], $pipes);
    register_shutdown_function(static fn () => proc_terminate($server));
    for ($i = 0; ; $i++) {
        $connection = @fsockopen('127.0.0.1', $port, $errno, $error, 0.1);
        if ($connection !== false) {
            fclose($connection);
            return "http://127.0.0.1:$port";
        }
        if ($i > 100) {
            fail('php -S did not start');
        }
        usleep(20_000);
    }
}

test('back off after a failure instead of retrying on every poll', function (): void {
    $dir = tempDir();
    Log::to("$dir/portal.log");
    // What Cloudflare answers when VoIP.ms is slow (seen live), counting the requests.
    $url = serve($dir, <<<'PHP'
        <?php
        file_put_contents(__DIR__ . '/requests', '.', FILE_APPEND);
        http_response_code(522);
        echo 'error code: 522';
        PHP);
    $requests = static fn () => strlen((string) @file_get_contents("$dir/requests"));
    $repo = freshRepo();
    $media = new Media("$dir/media", $dir, $repo, new Events($repo));
    $conversationId = $repo->getOrCreateConversation('4506575294', '4383980707');
    $messageId = $repo->insertMessage(['conversationId' => $conversationId, 'kind' => 'mms', 'remoteId' => '1', 'direction' => 'in', 'body' => '', 'sentAt' => 0, 'status' => 'received']);
    $id = $repo->insertAttachment($messageId, 0, ['remoteUrl' => "$url/media/x/media.png", 'status' => 'pending']);

    // Every tab's poll and every cron run goes through the queue.
    $media->drain(microtime(true) + 30);
    $media->drain(microtime(true) + 30);
    $media->drain(microtime(true) + 30);
    assertSame(1, $requests());
    $row = $repo->getAttachment($id);
    assertSame(['pending', 1], [$row['status'], $row['attempts']]);
    assertTrue($row['next_attempt_at'] > Time::nowMs(), 'the next attempt waits');

    // Once the wait is over, it tries again, then waits twice as long.
    Time::travelTo($row['next_attempt_at']);
    $media->drain(microtime(true) + 30);
    assertSame(2, $requests());
    $row = $repo->getAttachment($id);
    assertSame(['pending', 2], [$row['status'], $row['attempts']]);
    assertTrue($row['next_attempt_at'] >= Time::nowMs() + 59_000, 'the second wait is longer');

    // A download that gave up can be put back in the queue from the UI.
    $repo->updateAttachment($id, ['status' => 'failed']);
    assertTrue($repo->resetAttachment($id));
    $row = $repo->getAttachment($id);
    assertSame(['pending', 0, 0], [$row['status'], $row['attempts'], $row['next_attempt_at']]);
});
