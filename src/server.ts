import { Router } from 'itty-router';
import { Constants } from './constants';
import { handleStatus } from './status';
import { Strings } from './strings';

const router = Router();

const statusRequest = async (
  request: Request,
  event: FetchEvent,
  flags: InputFlags = {}
) => {
  const { handle, id, mediaNumber, language, prefix } = request.params;
  const url = new URL(request.url);
  const userAgent = request.headers.get('User-Agent') || '';

  const isBotUA =
    userAgent.match(/bot|facebook|embed|got|firefox\/92|curl|wget/gi) !== null;

  if (
    url.pathname.match(/\/status(es)?\/\d+\.(mp4|png|jpg)/g) !== null ||
    Constants.DIRECT_MEDIA_DOMAINS.includes(url.hostname) ||
    prefix === 'dl' ||
    prefix === 'dir'
  ) {
    console.log('Direct media request by extension');
    flags.direct = true;
  }

  if (
    url.pathname.match(/\/status(es)?\/\d+\.(json)/g) !== null ||
    url.hostname === Constants.API_HOST
  ) {
    console.log('JSON API request');
    flags.api = true;
  }

  if (isBotUA || flags.direct || flags.api) {
    console.log(`Matched bot UA ${userAgent}`);

    let response: Response;

    const statusResponse = await handleStatus(
      id?.match(/\d{2,20}/)?.[0] || '0',
      mediaNumber ? parseInt(mediaNumber) : undefined,
      userAgent,
      flags,
      language
    );

    if (statusResponse.response) {
      console.log('handleStatus sent response');
      response = statusResponse.response;
    } else if (statusResponse.text) {
      /* Fallback if a person browses to a direct media link with a Tweet without media */
      if (!isBotUA) {
        return Response.redirect(`${Constants.TWITTER_ROOT}/${handle}/status/${id}`, 302);
      }
      console.log('handleStatus sent embed');

      response = new Response(statusResponse.text, {
        headers: Constants.RESPONSE_HEADERS,
        status: 200
      });
    } else {
      response = new Response(Strings.ERROR_UNKNOWN, {
        headers: Constants.RESPONSE_HEADERS,
        status: 500
      });
    }

    return response;
  } else {
    console.log('Matched human UA', userAgent);
    return Response.redirect(`${Constants.TWITTER_ROOT}/${handle}/status/${id}`, 302);
  }
};

const profileRequest = async (request: Request) => {
  const { handle } = request.params;
  const url = new URL(request.url);

  if (handle.match(/\w{1,15}/gi)?.[0] !== handle) {
    return Response.redirect(Constants.REDIRECT_URL, 302);
  } else {
    return Response.redirect(`${Constants.TWITTER_ROOT}${url.pathname}`, 302);
  }
};

router.get('/:prefix?/:handle/status/:id', statusRequest);
router.get('/:prefix?/:handle/status/:id/photo/:mediaNumber', statusRequest);
router.get('/:prefix?/:handle/status/:id/photos/:mediaNumber', statusRequest);
router.get('/:prefix?/:handle/status/:id/video/:mediaNumber', statusRequest);
router.get('/:prefix?/:handle/statuses/:id', statusRequest);
router.get('/:prefix?/:handle/statuses/:id/photo/:mediaNumber', statusRequest);
router.get('/:prefix?/:handle/statuses/:id/photos/:mediaNumber', statusRequest);
router.get('/:prefix?/:handle/statuses/:id/video/:mediaNumber', statusRequest);
router.get('/:prefix?/:handle/status/:id/:language', statusRequest);
router.get('/:prefix?/:handle/statuses/:id/:language', statusRequest);
router.get('/status/:id', statusRequest);
router.get('/status/:id/:language', statusRequest);

router.get('/owoembed', async (request: Request) => {
  console.log('oembed hit!');
  const { searchParams } = new URL(request.url);

  /* Fallbacks */
  const text = searchParams.get('text') || 'Twitter';
  const author = searchParams.get('author') || 'dangeredwolf';
  const status = searchParams.get('status') || '1547514042146865153';

  const test = {
    author_name: decodeURIComponent(text),
    author_url: `${Constants.TWITTER_ROOT}/${encodeURIComponent(
      author
    )}/status/${encodeURIComponent(status)}`,
    provider_name: Constants.BRANDING_NAME_DISCORD,
    provider_url: Constants.REDIRECT_URL,
    title: Strings.DEFAULT_AUTHOR_TEXT,
    type: 'link',
    version: '1.0'
  };
  return new Response(JSON.stringify(test), {
    headers: {
      ...Constants.RESPONSE_HEADERS,
      'content-type': 'application/json'
    },
    status: 200
  });
});

router.get('/:handle', profileRequest);
router.get('/:handle/', profileRequest);

router.get('*', async (request: Request) => {
  const url = new URL(request.url);

  if (url.hostname === Constants.API_HOST) {
    return Response.redirect(Constants.API_DOCS_URL, 307);
  }
  return Response.redirect(Constants.REDIRECT_URL, 307);
});

const cacheWrapper = async (event: FetchEvent): Promise<Response> => {
  const { request } = event;
  const userAgent = request.headers.get('User-Agent') || '';
  // https://developers.cloudflare.com/workers/examples/cache-api/
  const cacheUrl = new URL(
    userAgent.includes('Telegram')
      ? `${request.url}&telegram`
      : userAgent.includes('Discord')
      ? `${request.url}&discord`
      : request.url
  );

  console.log('cacheUrl', cacheUrl);

  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = caches.default;

  /* Itty-router doesn't seem to like routing file names for some reason */
  if (cacheUrl.pathname === '/robots.txt') {
    return new Response(Constants.ROBOTS_TXT, {
      headers: {
        ...Constants.RESPONSE_HEADERS,
        'content-type': 'text/plain'
      },
      status: 200
    });
  }

  switch (request.method) {
    case 'GET':
      if (cacheUrl.hostname !== Constants.API_HOST) {
        const cachedResponse = await cache.match(cacheKey);

        if (cachedResponse) {
          console.log('Cache hit');
          return cachedResponse;
        }

        console.log('Cache miss');
      }

      // eslint-disable-next-line no-case-declarations
      const response = await router.handle(event.request, event);

      // Store the fetched response as cacheKey
      // Use waitUntil so you can return the response without blocking on
      // writing to cache
      event.waitUntil(cache.put(cacheKey, response.clone()));

      return response;
    /* Telegram sends this from Webpage Bot, and Cloudflare sends it if we purge cache, and we respect it.
       PURGE is not defined in an RFC, but other servers like Nginx apparently use it. */
    case 'PURGE':
      console.log('Purging cache as requested');
      await cache.delete(cacheKey);
      return new Response('', { status: 200 });
    case 'HEAD':
      return new Response('', {
        headers: Constants.RESPONSE_HEADERS,
        status: 200
      });
    case 'OPTIONS':
      return new Response('', {
        headers: {
          allow: Constants.RESPONSE_HEADERS.allow
        },
        status: 204
      });
    default:
      return new Response('', { status: 405 });
  }
};

/*
  Event to receive web requests on Cloudflare Worker
*/
addEventListener('fetch', async (event: FetchEvent) => {
  try {
    event.respondWith(cacheWrapper(event));
  } catch (e: unknown) {
    let error = e as Error;
    if (typeof EXCEPTION_DISCORD_WEBHOOK !== 'undefined') {
      try {
        const a = await fetch(EXCEPTION_DISCORD_WEBHOOK, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `${Constants.BRANDING_NAME}`
          },
          body: JSON.stringify({
            embeds: [
              {
                title: `Exception in ${Constants.BRANDING_NAME}`,
                description: `${error} - occurred while processing ${event.request.url}`,
              }
            ]
          })
        });
      } catch (e) {
        console.log('Failed to send caught exception to Discord', e);
      }
    }
  }
});
