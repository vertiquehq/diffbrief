package demo;

import io.vertx.core.Future;
import dev.vertique.job.delayed.DelayedJobHandlerMethod;

public class MailJob {
    @DelayedJobHandlerMethod("send-welcome")
    public Future<Void> send(String email) {
        return Future.succeededFuture();
    }
}
