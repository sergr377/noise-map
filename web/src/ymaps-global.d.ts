/**
 * Brings the global `ymaps3` namespace into scope.
 *
 * The types package declares it inside `declare global`, which only takes effect
 * once the module is actually pulled into the program. Relying on typeRoots
 * auto-inclusion did not do that here, so reference it explicitly.
 */
import '@yandex/ymaps3-types';
