package com.newbie7666.netpandownload.mobile;

import org.junit.Test;

import java.net.URI;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class InstagramPageTest {
    @Test
    public void findsReportedReelInPublicPagePayloadByItsExactMediaId() {
        String html = """
                <script type="application/json" data-sjs>{ malformed }</script>
                <script type="application/json" data-sjs>
                  {"require":[["Relay",[],[],[{"__bbox":{"result":{"data":{"xig_polaris_media":{
                    "if_not_gated_logged_out":{
                      "pk":"4024243963145524565","id":"POLARIS_4024243963145524565",
                      "user":{"username":"example"},
                      "video_versions":[
                        {"url":"https://scontent.cdninstagram.com/reel.mp4?token=abc&part=1","type":101},
                        {"url":"https://scontent.cdninstagram.com/reel-low.mp4","type":102}
                      ]
                    }
                  }}}}}]]]}
                </script>
                """;

        InstagramPage.Post post = InstagramPage.parse(html, "DfY_JAozJVV");
        assertNotNull(post);
        assertEquals("@example", post.title());
        assertEquals(1, post.videos().size());
        assertEquals(URI.create("https://scontent.cdninstagram.com/reel.mp4?token=abc&part=1"),
                post.videos().get(0).url());
    }

    @Test
    public void picksBestRenditionOfEveryVideoAndKeepsCarouselOrder() {
        String html = """
                <script data-sjs="true">{"media":[
                  {"code":"other","video_versions":[{"url":"https://scontent.cdninstagram.com/other.mp4"}]},
                  {"code":"B0","carousel_media":[
                    {"image_versions2":{"candidates":[]}},
                    {"video_versions":[
                      {"url":"https://scontent.cdninstagram.com/small.mp4","width":360,"height":640},
                      {"url":"https://scontent.cdninstagram.com/large.mp4","width":720,"height":1280}
                    ]},
                    {"video_versions":[{"url":"https://video.fbcdn.net/next.mp4"}]}
                  ]}
                ]}</script>
                """;

        InstagramPage.Post post = InstagramPage.parse(html, "B0");
        assertNotNull(post);
        assertEquals(2, post.videos().size());
        assertEquals(2, post.videos().get(0).position());
        assertEquals("/large.mp4", post.videos().get(0).url().getPath());
        assertEquals(3, post.videos().get(1).position());
        assertEquals("/next.mp4", post.videos().get(1).url().getPath());
    }

    @Test
    public void ignoresImagesAndVideosBelongingToOtherPosts() {
        String html = """
                <script data-sjs>{"items":[
                  {"code":"B0","image_versions2":{"candidates":[]}},
                  {"code":"B0more","video_versions":[{"url":"https://scontent.cdninstagram.com/other.mp4"}]}
                ]}</script>
                <script type="application/json">
                  {"code":"B0","video_versions":[{"url":"https://scontent.cdninstagram.com/unrelated.mp4"}]}
                </script>
                """;

        assertNull(InstagramPage.parse(html, "B0"));
    }

    @Test
    public void rejectsInsecureOrUnrelatedMediaUrls() {
        String html = """
                <script data-sjs>{"code":"B0","video_versions":[
                  {"url":"http://scontent.cdninstagram.com/example.mp4"},
                  {"url":"https://cdninstagram.com.example.org/example.mp4"},
                  {"url":"https://alice@video.fbcdn.net/example.mp4"},
                  {"url":"https://video.fbcdn.net:8443/example.mp4"}
                ]}</script>
                """;

        assertNull(InstagramPage.parse(html, "B0"));
    }
}
